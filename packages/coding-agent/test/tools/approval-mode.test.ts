import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@veyyon/agent-core";
import { getBundledModel } from "@veyyon/catalog/models";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { normalizeApprovalMode } from "@veyyon/coding-agent/tools/approval";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { useIsolatedGlobalSettings } from "../helpers/isolated-global-settings";

const BASE_SETTINGS = {
	"async.enabled": false,
	"bash.autoBackground.enabled": false,
	"bashInterceptor.enabled": false,
} as const;

function emptyWorkspaceTree(cwd: string) {
	return { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] };
}

function textOf(result: { content?: ReadonlyArray<{ type: string; text?: string }> }): string {
	const blocks = result.content ?? [];
	for (const block of blocks) {
		if (block.type === "text" && typeof block.text === "string") return block.text;
	}
	return "";
}

// `executeBash` calls `Settings.init()` itself, reaching past the session stub to
// the real config root and its agent.db. One line isolates the singleton for the
// whole file; see the helper for why a session `settings` object is not enough.
useIsolatedGlobalSettings();

describe("tools.approvalMode setting", () => {
	// The per-tool approval gate (ExtensionToolWrapper) reads approvalMode / tools.approval /
	// autoApprove exclusively from the execute-time AgentToolContext, never from the session's
	// own settings. So a single shared session exercises every mode — we only vary the context
	// settings per assertion. This avoids paying createAgentSession's cost (model registry,
	// auth-storage discovery, settings init) nine times over.
	let tempDir: string;
	let session: AgentSession;
	// Hoisted so every `execute` context can carry it. A context WITHOUT a
	// sessionManager makes tools fall back to the process-global agent dir, which
	// is the operator's real `~/.veyyon/profiles/<profile>/agent` — the bash tool
	// then tries to create storage there and the real-data guard fails the suite.
	let sessionManager: SessionManager;

	beforeAll(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-approval-mode-${Snowflake.next()}-`));
		const cwd = path.join(tempDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		sessionManager = SessionManager.create(cwd, path.join(tempDir, "sessions"));
		const created = await createAgentSession({
			cwd,
			agentDir: tempDir,
			sessionManager,
			authStorage: await isolatedAuthStorage(tempDir),
			settings: Settings.isolated(BASE_SETTINGS),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: emptyWorkspaceTree(cwd),
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["bash"],
		});
		session = created.session;
	});

	afterAll(async () => {
		await session.dispose();
		// Windows can briefly hold tempdir handles after session.dispose(); retry a few times.
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				removeSyncWithRetries(tempDir);
				break;
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") throw err;
				if (attempt === 4) break; // best-effort: OS will reclaim
				await Bun.sleep(50 * (attempt + 1));
			}
		}
	});

	function approvalSettings(extraSettings: Record<string, unknown> = {}): Settings {
		return Settings.isolated({ ...BASE_SETTINGS, ...extraSettings });
	}

	function bashTool() {
		const bash = session.getToolByName("bash");
		if (!bash) throw new Error("Expected bash tool");
		return bash;
	}

	/**
	 * yolo runs an exec-tier tool with no prompt even though no UI is attached.
	 * It is no longer the default rung, so the mode is set explicitly here: a test
	 * that relied on the default would silently start asserting the default's
	 * behavior instead of yolo's the next time the default moved.
	 */
	it("explicit yolo mode bypasses approval for non-overriding tool calls", async () => {
		const settings = approvalSettings({ "tools.approvalMode": "yolo" });
		const result = await bashTool().execute("yolo", { command: "echo ok" }, undefined, undefined, {
			settings,
			sessionManager,
		} as Partial<AgentToolContext> as AgentToolContext);
		expect(textOf(result)).toContain("ok");
	});

	/**
	 * With nothing configured the gate lands on `auto`, so an exec-tier tool runs
	 * unasked. No UI is attached, so a rung that prompted would surface as the
	 * "no interactive UI" rejection: the command's OUTPUT is therefore the proof
	 * that the unconfigured default really is the rung that runs, resolved
	 * through the live tool wrapper rather than read off the schema.
	 */
	it("runs an exec tool unasked when approvalMode is unconfigured", async () => {
		const settings = approvalSettings();
		const result = await bashTool().execute("default-auto", { command: "echo ok" }, undefined, undefined, {
			settings,
			sessionManager,
		} as Partial<AgentToolContext> as AgentToolContext);
		expect(textOf(result)).toContain("ok");
	});

	/**
	 * And the guards the default keeps. `auto` runs every tier, but a per-tool
	 * policy still outranks it, so raising the default did not turn the rung into
	 * an unconditional yolo.
	 */
	it("still honours a per-tool deny under the unconfigured default", async () => {
		const settings = approvalSettings({ "tools.approval": { bash: "deny" } });
		await expect(
			bashTool().execute("default-auto-deny", { command: "echo blocked" }, undefined, undefined, {
				settings,
				sessionManager,
			} as Partial<AgentToolContext> as AgentToolContext),
		).rejects.toThrow(/blocked by user policy/);
	});

	it("always-ask mode rejects exec tools when no UI is available", async () => {
		const settings = approvalSettings({ "tools.approvalMode": "always-ask" });
		await expect(
			bashTool().execute("always-ask", { command: "echo blocked" }, undefined, undefined, {
				settings,
				sessionManager,
			} as Partial<AgentToolContext> as AgentToolContext),
		).rejects.toThrow(/requires approval but no interactive UI available/);
	});

	it("per-tool allow overrides are honored in every mode", async () => {
		const settings = approvalSettings({
			"tools.approvalMode": "always-ask",
			"tools.approval": { bash: "allow" },
		});
		const result = await bashTool().execute("always-ask-allow", { command: "echo allowed" }, undefined, undefined, {
			settings,
			sessionManager,
		} as Partial<AgentToolContext> as AgentToolContext);
		expect(textOf(result)).toContain("allowed");
	});

	it("per-tool prompt overrides can tighten yolo mode", async () => {
		const settings = approvalSettings({
			"tools.approvalMode": "yolo",
			"tools.approval": { bash: "prompt" },
		});
		await expect(
			bashTool().execute("yolo-prompt", { command: "echo blocked" }, undefined, undefined, {
				settings,
				sessionManager,
			} as Partial<AgentToolContext> as AgentToolContext),
		).rejects.toThrow(/requires approval but no interactive UI available/);
	});

	it("write mode still prompts exec-tier tools", async () => {
		const settings = approvalSettings({
			"tools.approvalMode": "write",
			"tools.approval": {},
		});
		await expect(
			bashTool().execute("write-mode", { command: "echo unconfigured" }, undefined, undefined, {
				settings,
				sessionManager,
			} as Partial<AgentToolContext> as AgentToolContext),
		).rejects.toThrow(/requires approval but no interactive UI available/);
	});

	it("critical bash patterns do not prompt in yolo mode with bash allowed", async () => {
		const settings = approvalSettings({
			"tools.approvalMode": "yolo",
			"tools.approval": { bash: "allow" },
		});
		const result = await bashTool().execute(
			"critical",
			{ command: "rm -f /tmp/bun-fake-timer-probe.test.ts" },
			undefined,
			undefined,
			{
				settings,
				sessionManager,
			} as Partial<AgentToolContext> as AgentToolContext,
		);
		expect(textOf(result)).toContain("(no output)");
	});

	it("CLI --auto-approve forces yolo mode for non-overriding tool calls", async () => {
		const settings = approvalSettings({ "tools.approvalMode": "always-ask" });
		const result = await bashTool().execute("cli-override", { command: "echo override" }, undefined, undefined, {
			settings,
			autoApprove: true,
		} as Partial<AgentToolContext> as AgentToolContext);
		expect(textOf(result)).toContain("override");
	});

	it("CLI --auto-approve also bypasses safety-override patterns", async () => {
		const settings = approvalSettings({ "tools.approvalMode": "always-ask" });
		const result = await bashTool().execute(
			"cli-critical",
			{ command: "rm -f /tmp/bun-fake-timer-probe.test.ts" },
			undefined,
			undefined,
			{
				settings,
				autoApprove: true,
			} as Partial<AgentToolContext> as AgentToolContext,
		);
		expect(textOf(result)).toContain("(no output)");
	});

	it("normalizes shipped autonomy ladder and legacy aliases", () => {
		expect(normalizeApprovalMode("plan")).toBe("plan");
		expect(normalizeApprovalMode("ask")).toBe("ask");
		expect(normalizeApprovalMode("ask-command")).toBe("ask-command");
		expect(normalizeApprovalMode("auto")).toBe("auto");
		expect(normalizeApprovalMode("yolo")).toBe("yolo");
		expect(normalizeApprovalMode("always-ask")).toBe("ask");
		expect(normalizeApprovalMode("auto-edit")).toBe("ask-command");
		expect(normalizeApprovalMode("write")).toBe("ask-command");
	});

	it("plan mode blocks exec-tier tools", async () => {
		const settings = approvalSettings({ "tools.approvalMode": "plan" });
		await expect(
			bashTool().execute("plan-blocked", { command: "echo no" }, undefined, undefined, {
				settings,
				sessionManager,
			} as Partial<AgentToolContext> as AgentToolContext),
		).rejects.toThrow(/Plan autonomy: non-mutating tools only/);
	});

	it("constructs an extensionRunner unconditionally so the approval gate is always installed", async () => {
		// Regression lock for the architectural fix: the per-tool approval gate is implemented
		// inside `ExtensionToolWrapper`, which is only attached when `session.extensionRunner` exists.
		// Historically the runner was conditional on `extensionsResult.extensions.length > 0`, which
		// meant the entire approval system silently disappeared for users with no extensions loaded —
		// any non-yolo approval mode setting would be a no-op without feedback. The
		// fix is to construct the runner unconditionally; this test makes that contract explicit so
		// a future change to make the runner optional again cannot silently re-open the hole.
		//
		// This session was built with `disableExtensionDiscovery: true` and no extensions, which is
		// exactly the configuration that used to leave the runner absent. Asserting the runner
		// EXISTS is only half of it: the point is that a gated rung still gates, so the assertion
		// below drives a real exec-tier call through the wrapper and requires the refusal. A runner
		// that existed but wrapped nothing would let the command run and print its output.
		expect(session.extensionRunner).toBeDefined();

		const settings = approvalSettings({ "tools.approvalMode": "plan" });
		await expect(
			bashTool().execute("gate-installed", { command: "echo gate-bypassed" }, undefined, undefined, {
				settings,
				sessionManager,
			} as Partial<AgentToolContext> as AgentToolContext),
		).rejects.toThrow(/Plan autonomy: non-mutating tools only/);
	});
});
