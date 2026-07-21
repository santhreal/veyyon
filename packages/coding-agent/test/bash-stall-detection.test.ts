/**
 * Coverage for the two bash backgrounding levers over the managed-job path.
 *
 * Both are opt-in and share the same machinery (BashTool.execute → managed
 * async job → foreground wait):
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
import { removeSyncWithRetries } from "@veyyon/utils";

let artifactCounter = 0;

function makeSession(cwd: string, manager: AsyncJobManager, overrides: Partial<Record<string, unknown>>): ToolSession {
	const sessionDir = path.join(cwd, "session");
	return {
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
	} as unknown as ToolSession;
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
});
