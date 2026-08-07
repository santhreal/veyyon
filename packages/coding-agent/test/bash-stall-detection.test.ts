/**
 * Coverage for the three bash backgrounding levers over the managed-job path.
 *
 * All share the same machinery (BashTool.execute → managed async job →
 * foreground wait):
 *
 *   - Auto-background (`bash.autoBackground.enabled` + `.thresholdMs`) fires on
 *     WALL-CLOCK time regardless of whether output is streaming: a long command
 *     that is happily printing still holds the model and blows past the prompt
 *     cache, so it is backgrounded with the plain "delivered automatically"
 *     notice (reason `threshold`).
 *   - Stall detection (`bash.stallDetection.enabled` + `.stallMs`) fires on IDLE
 *     time: a command that stops producing output for the stall window is
 *     backgrounded with a distinct "may be stuck" notice (reason `stall`) that
 *     names the job id and the `job cancel` path so the model can abort a
 *     genuinely hung command. It recommends, it never force-kills.
 *
 * These drive real processes with small windows and wide margins (stall/threshold
 * >= 3x the output cadence) so the timing is deterministic without wall-clock
 * sleeps in the test body.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@veyyon/coding-agent/async";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import type { BashToolDetails } from "@veyyon/coding-agent/tools/bash";
import { BashTool } from "@veyyon/coding-agent/tools/bash";
import { hasForegroundBashWait, requestManualBackground } from "@veyyon/coding-agent/tools/bash-foreground-registry";
import { removeSyncWithRetries } from "@veyyon/utils";
import { useIsolatedGlobalSettings } from "./helpers/isolated-global-settings";
import { makeToolSession } from "./helpers/tool-session";

// `executeBash` initializes the GLOBAL Settings singleton itself, so a session
// stub alone leaves it loading the developer's real ~/.veyyon agent.db.
useIsolatedGlobalSettings();

let artifactCounter = 0;

function makeSession(cwd: string, manager: AsyncJobManager, overrides: Partial<Record<string, unknown>>): ToolSession {
	const sessionDir = path.join(cwd, "session");
	return makeToolSession({
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => sessionDir,
		allocateOutputArtifact: async (toolType: string) => {
			fs.mkdirSync(sessionDir, { recursive: true });
			const id = `artifact-${++artifactCounter}`;
			return { id, path: path.join(sessionDir, `${id}.${toolType}.log`) };
		},
		asyncJobManager: manager,
		settings: Settings.isolated(overrides),
	});
}

function resultText(result: { content: Array<{ type: string }> }): string {
	const block = result.content.find((b): b is { type: "text"; text: string } => b.type === "text");
	return block?.text ?? "";
}

function asyncDetails(result: { details?: BashToolDetails }): NonNullable<BashToolDetails["async"]> {
	const async = result.details?.async;
	if (!async) throw new Error("expected an async (backgrounded) result");
	return async;
}

describe("bash stall detection and wall-clock auto-background", () => {
	let tempDir: string;
	let manager: AsyncJobManager;

	beforeAll(async () => {
		// Hoist the one-time shell warmup out of the first timed command so cold
		// setup never eats into a stall/threshold window.
		const warmDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-stall-warm-"));
		const warmManager = new AsyncJobManager({ onJobComplete: async () => {} });
		await new BashTool(makeSession(warmDir, warmManager, {})).execute("warm", { command: "true" });
		removeSyncWithRetries(warmDir);
	});

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-stall-"));
		manager = new AsyncJobManager({ onJobComplete: async () => {} });
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	afterAll(() => {
		// Nothing global to tear down; per-test managers are dropped with tempDir.
	});

	it("backgrounds a quiet command with the may-be-stuck notice and reason 'stall'", async () => {
		const session = makeSession(tempDir, manager, {
			"bash.autoBackground.enabled": false,
			"bash.stallDetection.enabled": true,
			"bash.stallDetection.stallMs": 150,
		});
		const tool = new BashTool(session);
		// Produces no output at all, so idle time climbs straight to the window.
		const result = await tool.execute("stall-1", { command: "sleep 1", timeout: 30 });
		const async = asyncDetails(result);
		const text = resultText(result);

		expect(async.state).toBe("running");
		expect(async.reason).toBe("stall");
		expect(text).toContain("may be stuck");
		expect(text).toContain(`Backgrounded as job ${async.jobId}`);
		expect(text).toContain(`cancel: ["${async.jobId}"]`);
		// It only recommends; the job is still running until we abort it.
		expect(manager.cancel(async.jobId)).toBe(true);
	});

	it("does not stall while output keeps flowing, and returns the real result", async () => {
		const session = makeSession(tempDir, manager, {
			"bash.autoBackground.enabled": false,
			"bash.stallDetection.enabled": true,
			// 400ms window vs a 50ms output cadence: 8x margin, never idle enough.
			"bash.stallDetection.stallMs": 400,
		});
		const tool = new BashTool(session);
		const result = await tool.execute("stall-2", {
			command: "for i in $(seq 1 20); do echo line$i; sleep 0.05; done",
			timeout: 30,
		});
		const text = resultText(result);

		expect(result.details?.async).toBeUndefined();
		expect(text).not.toContain("may be stuck");
		expect(text).toContain("line20");
	});

	it("wall-clock auto-background fires on streaming output with reason 'threshold'", async () => {
		const session = makeSession(tempDir, manager, {
			"bash.autoBackground.enabled": true,
			// Fires long before the ~2s command finishes, while it is still printing.
			"bash.autoBackground.thresholdMs": 200,
			"bash.stallDetection.enabled": false,
		});
		const tool = new BashTool(session);
		const result = await tool.execute("wall-1", {
			command: "for i in $(seq 1 40); do echo line$i; sleep 0.05; done",
			timeout: 30,
		});
		const async = asyncDetails(result);
		const text = resultText(result);

		expect(async.state).toBe("running");
		expect(async.reason).toBe("threshold");
		expect(text).toContain(`Backgrounded as job ${async.jobId}`);
		// The plain notice, not the stall notice.
		expect(text).not.toContain("may be stuck");
		expect(manager.cancel(async.jobId)).toBe(true);
	});

	it("stall-only mode (auto-background off) still backgrounds a stalled command", async () => {
		const session = makeSession(tempDir, manager, {
			// No wall-clock timer at all; only the idle-stall lever is armed.
			"bash.autoBackground.enabled": false,
			"bash.stallDetection.enabled": true,
			"bash.stallDetection.stallMs": 150,
		});
		const tool = new BashTool(session);
		const result = await tool.execute("stall-only", { command: "sleep 1", timeout: 30 });
		const async = asyncDetails(result);

		expect(async.reason).toBe("stall");
		expect(manager.cancel(async.jobId)).toBe(true);
	});

	/** The third lever: the operator's background key (`app.bash.background`,
	 * default Ctrl+B). The TUI resolves the foreground wait through the
	 * registry; the run converts with reason `manual` and its own notice —
	 * the user's explicit 2026-07-22 ask (no way to reclaim the turn from a
	 * long command besides waiting or interrupting). */
	it("manual background request converts the wait with reason 'manual'", async () => {
		const session = makeSession(tempDir, manager, {
			"bash.autoBackground.enabled": false,
			"bash.stallDetection.enabled": true,
			// Huge windows: only the manual request can win the race.
			"bash.stallDetection.stallMs": 60_000,
		});
		const tool = new BashTool(session);
		const pending = tool.execute("manual-1", { command: "sleep 5", timeout: 30 });
		// Fire the keystroke once the wait registers (same signal the hint uses).
		await waitForForegroundWait();
		expect(requestManualBackground()).toBe(true);
		const result = await pending;
		const async = asyncDetails(result);
		const text = resultText(result);

		expect(async.state).toBe("running");
		expect(async.reason).toBe("manual");
		expect(text).toContain(`Backgrounded as job ${async.jobId} at the operator's request`);
		expect(text).not.toContain("may be stuck");
		expect(manager.cancel(async.jobId)).toBe(true);
	});

	/** Negative twin: with no wait registered the request reports false and
	 * a normal command completes in the foreground untouched. */
	it("manual request is a no-op after the command completes", async () => {
		const session = makeSession(tempDir, manager, {
			"bash.autoBackground.enabled": false,
			"bash.stallDetection.enabled": true,
			"bash.stallDetection.stallMs": 60_000,
		});
		const tool = new BashTool(session);
		const result = await tool.execute("manual-2", { command: "echo done", timeout: 30 });
		expect(result.details?.async).toBeUndefined();
		expect(resultText(result)).toContain("done");
		expect(requestManualBackground()).toBe(false);
	});
	/**
	 * THE STOCK INSTALL. Both auto levers off is what a fresh profile used to
	 * look like, and the managed-job route was gated on one of them being on.
	 * The foreground wait is what publishes the registry entry, so with both off
	 * nothing registered: `hasForegroundBashWait()` stayed false, the composer
	 * never raised the `ctrl+b background` chip, and the keybinding fell through
	 * to readline cursor-left. A documented shortcut that silently did nothing.
	 *
	 * Reported 2026-08-06: "there is no hint below the command that says you can
	 * background nor does it work". Both halves are this one gate.
	 */
	it("registers the wait and honours the background key with both auto levers off", async () => {
		const session = makeSession(tempDir, manager, {
			"bash.autoBackground.enabled": false,
			"bash.stallDetection.enabled": false,
		});
		const tool = new BashTool(session);
		const pending = tool.execute("manual-off", { command: "sleep 5", timeout: 30 });

		// The chip's gate. False here is the bug the operator saw as a missing hint.
		await waitForForegroundWait();
		expect(hasForegroundBashWait()).toBe(true);
		expect(requestManualBackground()).toBe(true);

		const result = await pending;
		const async = asyncDetails(result);
		expect(async.state).toBe("running");
		expect(async.reason).toBe("manual");
		expect(resultText(result)).toContain(`Backgrounded as job ${async.jobId} at the operator's request`);
		expect(manager.cancel(async.jobId)).toBe(true);
	});

	/**
	 * A configured "Immediately" is a real choice; a clamped zero is not.
	 * `#resolveWaitMs` collapses the wall timer to 0 when the command's own
	 * timeout would fire first, and `startBackgrounded` used to read that
	 * collapsed value. Harmless while auto-background shipped off, but the
	 * moment it became the default every short-timeout command would have been
	 * shunted straight to a background job without ever running in view.
	 */
	it("does not background a short-timeout command that merely clamps the timer to zero", async () => {
		const session = makeSession(tempDir, manager, {
			"bash.autoBackground.enabled": true,
			"bash.autoBackground.thresholdMs": 300_000,
			"bash.stallDetection.enabled": false,
		});
		const tool = new BashTool(session);
		const result = await tool.execute("clamp-1", { command: "echo inline", timeout: 1 });

		expect(result.details?.async).toBeUndefined();
		expect(resultText(result)).toContain("inline");
	});

	/**
	 * The per-call lever. A model that already knows a command is slow should not
	 * have to hold the foreground for the configured default, and one that needs
	 * output inline should be able to buy more time. `backgroundAfter` overrides
	 * the setting in both directions, and asking for it IS the opt-in: it arms the
	 * wall-clock timer even with auto-background switched off.
	 */
	it("backgrounds immediately on backgroundAfter 0 even with auto-background off", async () => {
		const session = makeSession(tempDir, manager, {
			"bash.autoBackground.enabled": false,
			"bash.stallDetection.enabled": false,
		});
		const tool = new BashTool(session);
		const result = await tool.execute("after-0", { command: "sleep 5", timeout: 30, backgroundAfter: 0 });

		const async = asyncDetails(result);
		expect(async.state).toBe("running");
		expect(async.reason).toBe("threshold");
		expect(manager.cancel(async.jobId)).toBe(true);
	});

	it("lets backgroundAfter beat a configured threshold that would never fire", async () => {
		const session = makeSession(tempDir, manager, {
			"bash.autoBackground.enabled": true,
			// Far past the command's own timeout: only the per-call value can win.
			"bash.autoBackground.thresholdMs": 600_000,
			"bash.stallDetection.enabled": false,
		});
		const tool = new BashTool(session);
		const result = await tool.execute("after-short", { command: "sleep 5", timeout: 30, backgroundAfter: 0.2 });

		const async = asyncDetails(result);
		expect(async.state).toBe("running");
		expect(async.reason).toBe("threshold");
		expect(manager.cancel(async.jobId)).toBe(true);
	});

	/** The other direction: a generous per-call budget keeps a quick command inline. */
	it("keeps a fast command in the foreground when backgroundAfter is generous", async () => {
		const session = makeSession(tempDir, manager, {
			"bash.autoBackground.enabled": true,
			"bash.autoBackground.thresholdMs": 0,
			"bash.stallDetection.enabled": false,
		});
		const tool = new BashTool(session);
		const result = await tool.execute("after-long", { command: "echo kept", timeout: 30, backgroundAfter: 60 });

		expect(result.details?.async).toBeUndefined();
		expect(resultText(result)).toContain("kept");
	});
});

/** Resolve once the foreground wait registers (poll capped at 2s — the wait
 * registers within the execute() call's first ticks). */
async function waitForForegroundWait(): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!hasForegroundBashWait()) {
		if (Date.now() > deadline) throw new Error("foreground bash wait never registered");
		await Bun.sleep(10);
	}
}
