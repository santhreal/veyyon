/**
 * GRAN-4: the MAIN (top-level) session records a `session_init` entry with its
 * exact system prompt + active tools at start — the same entry type a subagent
 * writes — so the main agent's run is replayable/backtestable at full fidelity.
 *
 * Why this suite exists:
 *   Subagents persisted `session_init` (exact system prompt, tools) enabling
 *   faithful revive/replay, but the main top-level session did not: its exact
 *   system prompt AS SENT was never in the record, only reconstructable from
 *   config. A faithful backtest of the main agent could not reproduce the exact
 *   prompt bytes. This asymmetry is closed by writing `session_init` for the main
 *   session too, reusing the SAME entry + append method (ONE PLACE).
 *
 * The contract these tests lock in:
 *   - A NEW main session created through `createAgentSession` writes exactly one
 *     `session_init` whose `systemPrompt` equals the live session's assembled
 *     prompt (and contains the caller's custom text) and whose `tools` equal the
 *     session's active tool names — recoverable from the on-disk file.
 *   - A RESUMED session does NOT append a second `session_init` (the entry is
 *     written once, on new-session creation, never duplicated on resume).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import type { SessionInitEntry } from "@veyyon/coding-agent/session/session-entries";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

const CUSTOM_PROMPT = "You are the MAIN test agent guarding GRAN-4.";

function assistantMessage(text: string) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function initEntries(entries: readonly { type: string }[]): SessionInitEntry[] {
	return entries.filter((e): e is SessionInitEntry => e.type === "session_init");
}

describe("GRAN-4: main session records its exact system prompt + tools", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const tempDirs: TempDir[] = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("gran4-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		sharedDir.removeSync();
	});

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) dir.removeSync();
	});

	function tmp(): string {
		const dir = TempDir.createSync("gran4-");
		tempDirs.push(dir);
		return dir.path();
	}

	function baseOptions(cwd: string, sessionManager: SessionManager) {
		return {
			cwd,
			agentDir: cwd,
			authStorage,
			modelRegistry,
			sessionManager,
			settings: Settings.isolated(),
			systemPrompt: CUSTOM_PROMPT,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		};
	}

	it("writes exactly one session_init with the live prompt + active tools, recoverable from disk", async () => {
		const cwd = tmp();
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		const { session } = await createAgentSession(baseOptions(cwd, manager));
		// Capture what the LIVE session actually holds, to compare against the record.
		const livePrompt = session.agent.state.systemPrompt.join("\n\n");
		const liveTools = session.getActiveToolNames();

		// Force the buffered session_init to disk with a real assistant turn, then reload.
		manager.appendMessage(assistantMessage("hello from main"));
		manager.flushSync();
		await session.dispose();

		const reopened = await SessionManager.open(sessionFile, sessionDir);
		const inits = initEntries(reopened.getEntries());
		expect(inits).toHaveLength(1);
		const init = inits[0]!;
		// Exact prompt bytes as sent — not a reconstruction.
		expect(init.systemPrompt).toBe(livePrompt);
		expect(init.systemPrompt).toContain(CUSTOM_PROMPT);
		// The active tool set is captured verbatim.
		expect(init.tools).toEqual(liveTools);
		expect(init.tools.length).toBeGreaterThan(0);
		await reopened.close();
	});

	it("does not append a second session_init when the same session is resumed", async () => {
		const cwd = tmp();
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		const first = await createAgentSession(baseOptions(cwd, manager));
		manager.appendMessage(assistantMessage("first turn"));
		manager.flushSync();
		await first.session.dispose();

		// Resume the persisted session — hasExistingSession is now true.
		const resumeManager = await SessionManager.open(sessionFile, sessionDir);
		const resumed = await createAgentSession(baseOptions(cwd, resumeManager));
		resumeManager.appendMessage(assistantMessage("second turn"));
		resumeManager.flushSync();
		await resumed.session.dispose();

		const reopened = await SessionManager.open(sessionFile, sessionDir);
		// Still exactly one init entry: resume must not duplicate it.
		expect(initEntries(reopened.getEntries())).toHaveLength(1);
		await reopened.close();
	});
});
