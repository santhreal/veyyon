/**
 * WHY: "is this tool result final?" had two deciders that disagreed.
 *
 * A backgrounded `task` returns a result while its subagent keeps running, with
 * `details.async.state === "running"`. The live event path in
 * `event-controller.ts` reads that, marks the result partial, and KEEPS the
 * component in `pendingTools` so later progress can reach it. The transcript
 * rebuild in `ui-helpers.ts` re-derives the whole chat from message history and
 * settled every result unconditionally: `updateResult(message, false, id)`
 * followed by `pendingTools.delete(id)`.
 *
 * `renderSessionContext` runs on a terminal resize, a theme switch and a session
 * switch. Any of those sealed a running subagent's card mid-flight and dropped
 * its id, so its remaining progress had nowhere to land — and the turn-end
 * reconciler then pruned the id from the background set because it filters on
 * `pendingTools` membership, making the loss permanent for that turn.
 *
 * The class this closes: one concept decided independently on the live path and
 * the rebuild path. Both now read `isLiveBackgroundTask` from
 * `modes/utils/async-tool-state.ts`, which is also the only reader of the
 * `details.async` shape that six call sites used to cast inline.
 *
 * What this suite does NOT catch: it drives `renderSessionContext` directly
 * rather than resizing a real terminal, so a change to which events trigger a
 * rebuild is outside it. It also asserts only the `task` tool; a backgrounded
 * `bash` job is deliberately settled on return, and that asymmetry is pinned
 * here so widening the predicate turns this red.
 */
import "./helpers/tool-views-preload";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/coding-agent/modes/interactive-mode";
import { initTheme, setTheme, stopThemeWatcher } from "@veyyon/coding-agent/modes/theme/theme";
import { isLiveBackgroundTask } from "@veyyon/coding-agent/modes/utils/async-tool-state";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { TUI } from "@veyyon/tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const WIDTH = 120;
const TEST_PARENT = path.resolve(import.meta.dirname, "../../../.internal/running-subagent-rebuild");
const TASK_CALL_ID = "call_task_running";
const BASH_CALL_ID = "call_bash_running";

let testRoot = "";

/** An assistant turn that opened `toolName` under `callId`. */
function assistantToolCall(callId: string, toolName: string, timestamp: number) {
	return {
		role: "assistant" as const,
		content: [{ type: "toolCall" as const, id: callId, name: toolName, arguments: {} }],
		stopReason: "toolUse" as const,
		api: "anthropic" as const,
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	};
}

/** The result a long-running tool returns while its work continues. */
function runningResult(callId: string, toolName: string, timestamp: number) {
	return {
		role: "toolResult" as const,
		toolCallId: callId,
		toolName,
		content: [{ type: "text" as const, text: "started" }],
		isError: false,
		details: { async: { state: "running", jobId: "job-1", type: toolName } },
		timestamp,
	};
}

describe("a running subagent survives a transcript rebuild", () => {
	let tempDir: string | undefined;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;
	let mode: InteractiveMode | undefined;
	let terminal: VirtualTerminal | undefined;
	let eventBus: EventBus | undefined;

	beforeAll(async () => {
		await fs.mkdir(TEST_PARENT, { recursive: true });
		testRoot = await fs.mkdtemp(path.join(TEST_PARENT, "run-"));
		await initTheme();
		await setTheme("dark");
	});

	beforeEach(async () => {
		resetSettingsForTest();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		tempDir = await fs.mkdtemp(path.join(testRoot, "main-"));
		await Settings.init({ inMemory: true, cwd: tempDir, overrides: { "startup.quiet": true } });

		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Main"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir, tempDir),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});

		eventBus = new EventBus();
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, eventBus);
		terminal = new VirtualTerminal(WIDTH, 40);
		mode.ui = new TUI(terminal);
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		await mode.init();
		await terminal.waitForRender();
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
		mode = undefined;
		session = undefined;
		terminal = undefined;
		eventBus = undefined;
		vi.restoreAllMocks();
		resetSettingsForTest();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterAll(async () => {
		stopThemeWatcher();
		await fs.rm(testRoot, { recursive: true, force: true });
	});

	it("keeps a running task pending so its later progress still lands", async () => {
		if (!mode || !terminal || !session) throw new Error("not booted");

		const manager = session.sessionManager;
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "spawn a worker" }], timestamp: 1 });
		manager.appendMessage(assistantToolCall(TASK_CALL_ID, "task", 2));
		manager.appendMessage(runningResult(TASK_CALL_ID, "task", 3));

		mode.renderSessionContext(session.buildTranscriptSessionContext({ collapseCompactedHistory: false }), {
			populateHistory: true,
		});
		await terminal.waitForRender();

		expect(mode.pendingTools.has(TASK_CALL_ID)).toBe(true);
		expect(mode.settledToolCalls.has(TASK_CALL_ID)).toBe(false);
	});

	it("still settles a backgrounded bash job, whose outcome arrives separately", async () => {
		if (!mode || !terminal || !session) throw new Error("not booted");

		const manager = session.sessionManager;
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "run it" }], timestamp: 1 });
		manager.appendMessage(assistantToolCall(BASH_CALL_ID, "bash", 2));
		manager.appendMessage(runningResult(BASH_CALL_ID, "bash", 3));

		mode.renderSessionContext(session.buildTranscriptSessionContext({ collapseCompactedHistory: false }), {
			populateHistory: true,
		});
		await terminal.waitForRender();

		expect(mode.pendingTools.has(BASH_CALL_ID)).toBe(false);
	});

	// The predicate both paths read. Pinned directly so the asymmetry above is a
	// recorded decision rather than an accident of which tools were tested.
	it("treats only a running task as live background work", () => {
		const running = { async: { state: "running" } };
		expect(isLiveBackgroundTask("task", running)).toBe(true);
		expect(isLiveBackgroundTask("bash", running)).toBe(false);
		expect(isLiveBackgroundTask("task", { async: { state: "completed" } })).toBe(false);
		expect(isLiveBackgroundTask("task", { async: { state: "failed" } })).toBe(false);
		expect(isLiveBackgroundTask("task", undefined)).toBe(false);
		expect(isLiveBackgroundTask(undefined, running)).toBe(false);
	});
});
