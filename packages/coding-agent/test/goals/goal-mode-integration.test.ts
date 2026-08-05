import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentEvent } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { GoalTool } from "@veyyon/coding-agent/goals/tools/goal-tool";
import { InteractiveMode } from "@veyyon/coding-agent/modes/interactive-mode";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { normalizeCustomMessagePayload } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import type { DiscoverableTool } from "@veyyon/coding-agent/tool-discovery/tool-index";
import { createTools, type Tool, type ToolSession } from "@veyyon/coding-agent/tools";
import type { TodoPhase } from "@veyyon/coding-agent/tools/todo";
import { TempDir } from "@veyyon/utils";

function createToolSession(cwd: string, settings: Settings, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
		...overrides,
	};
}

type GoalHarness = {
	tempDir: TempDir;
	settings: Settings;
	session: AgentSession;
	mode: InteractiveMode;
	toolSession: ToolSession;
	toolRegistry: Map<string, Tool>;
	cleanup: () => Promise<void>;
};

// Immutable, expensive fixtures shared across every test. `new ModelRegistry`
// alone is ~110ms (loads + parses the bundled model catalog), which dominated
// this file's wall time when rebuilt per test. The registry, its auth storage,
// and the resolved model are never mutated by goal-mode flows, and
// AgentSession.dispose() never closes authStorage — so a single shared instance
// is safe and drops ~8×110ms of pure setup overhead.
type SharedFixture = {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	model: Model;
	baseDir: TempDir;
};

async function createSharedFixture(): Promise<SharedFixture> {
	const baseDir = TempDir.createSync("@pi-goal-mode-shared-");
	const authStorage = await AuthStorage.create(path.join(baseDir.path(), "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Expected claude-sonnet-4-5 to exist in registry");
	}
	return { authStorage, modelRegistry, model, baseDir };
}

async function createGoalHarness(shared: SharedFixture): Promise<GoalHarness> {
	resetSettingsForTest();
	const tempDir = TempDir.createSync("@pi-goal-mode-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const { modelRegistry, model } = shared;

	const settings = Settings.isolated({
		"compaction.enabled": false,
		"goal.enabled": true,
		"plan.enabled": true,
	});
	const bootstrapToolSession = createToolSession(tempDir.path(), settings);
	const initialTools = await createTools(bootstrapToolSession, ["read"]);
	const toolRegistry = new Map<string, Tool>(initialTools.map(tool => [tool.name, tool] as const));

	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: initialTools,
				messages: [],
			},
		}),
		sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
		settings,
		modelRegistry,
		toolRegistry,
		builtInToolNames: ["read", "todo", "goal"],
		rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
	});
	const mode = new InteractiveMode(session, "test");
	const toolSession = createToolSession(tempDir.path(), settings, {
		getGoalModeState: () => session.getGoalModeState(),
		getGoalRuntime: () => session.goalRuntime,
		getTodoPhases: () => session.getTodoPhases(),
		setTodoPhases: phases => session.setTodoPhases(phases),
	});
	for (const tool of await createTools(toolSession, ["todo"])) {
		toolRegistry.set(tool.name, tool);
	}
	toolRegistry.set("goal", new GoalTool(toolSession) as unknown as Tool);

	return {
		tempDir,
		settings,
		session,
		mode,
		toolSession,
		toolRegistry,
		cleanup: async () => {
			mode.stop();
			await session.dispose();
			tempDir.removeSync();
			resetSettingsForTest();
		},
	};
}

async function toolNamesFor(harness: GoalHarness): Promise<string[]> {
	return (await createTools(harness.toolSession, harness.session.getActiveToolNames())).map(tool => tool.name);
}

async function waitForMicrotasks(): Promise<void> {
	// Pure microtask flush — deterministic and fake-timer-safe (no macrotask /
	// real-clock dependency). Lets queued `.then` callbacks settle so a fired
	// continuation tick would be observed before we assert it was dropped.
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

async function armInputWaiter(mode: InteractiveMode): Promise<{
	inputPromise: Promise<void>;
	getResolvedText: () => string | undefined;
}> {
	let resolvedText: string | undefined;
	const inputPromise = mode.getUserInput().then(input => {
		resolvedText = input.text;
	});
	await waitForMicrotasks();
	return {
		inputPromise,
		getResolvedText: () => resolvedText,
	};
}

describe("InteractiveMode goal mode integration", () => {
	let harness: GoalHarness;
	let shared: SharedFixture;

	beforeAll(async () => {
		initTheme();
		shared = await createSharedFixture();
	});

	afterAll(() => {
		shared.authStorage.close();
		shared.baseDir.removeSync();
	});

	beforeEach(async () => {
		harness = await createGoalHarness(shared);
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		await harness.cleanup();
	});

	it("toggles goal tool exposure when goal mode enters and pauses", async () => {
		expect(await toolNamesFor(harness)).not.toContain("goal");

		await harness.mode.handleGoalModeCommand("Ship the release");

		expect(harness.mode.goalModeEnabled).toBe(true);
		expect(harness.session.getGoalModeState()?.enabled).toBe(true);
		expect(await toolNamesFor(harness)).toContain("goal");

		vi.spyOn(harness.mode, "showHookSelector").mockResolvedValue("Pause");
		await harness.mode.handleGoalModeCommand();

		expect(harness.mode.goalModeEnabled).toBe(false);
		expect(harness.mode.goalModePaused).toBe(true);
		expect(harness.session.getGoalModeState()?.goal.status).toBe("paused");
		expect(await toolNamesFor(harness)).not.toContain("goal");
	});

	it("replaces the active goal via /goal set", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		const originalGoal = harness.session.getGoalModeState()?.goal;
		if (!originalGoal) throw new Error("expected active goal");

		await harness.mode.handleGoalModeCommand("set Replace the objective");

		const state = harness.session.getGoalModeState();
		expect(state?.enabled).toBe(true);
		expect(state?.goal.objective).toBe("Replace the objective");
		expect(state?.goal.status).toBe("active");
		expect(state?.goal.id).not.toBe(originalGoal.id);
		expect(harness.mode.goalModeEnabled).toBe(true);
		expect(await toolNamesFor(harness)).toContain("goal");
	});

	it("defers initial goal objective submission while streaming", async () => {
		let streaming = true;
		Object.defineProperty(harness.session, "isStreaming", { configurable: true, get: () => streaming });
		const sendGoalModeContext = vi.spyOn(harness.session, "sendGoalModeContext").mockResolvedValue();
		const waiter = await armInputWaiter(harness.mode);

		await harness.mode.handleGoalModeCommand("Ship the release");
		await waitForMicrotasks();

		expect(harness.session.getGoalModeState()?.goal.objective).toBe("Ship the release");
		expect(sendGoalModeContext).toHaveBeenCalledWith({ deliverAs: "steer" });
		expect(waiter.getResolvedText()).toBeUndefined();

		streaming = false;
		harness.mode.onInputCallback?.(harness.mode.startPendingSubmission({ text: "cleanup" }));
		await waiter.inputPromise;
	});

	it("defers replacement goal objective submission while streaming", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		let streaming = true;
		Object.defineProperty(harness.session, "isStreaming", { configurable: true, get: () => streaming });
		const sendGoalModeContext = vi.spyOn(harness.session, "sendGoalModeContext").mockResolvedValue();
		const waiter = await armInputWaiter(harness.mode);

		await harness.mode.handleGoalModeCommand("set Replace the objective");
		await waitForMicrotasks();

		expect(harness.session.getGoalModeState()?.goal.objective).toBe("Replace the objective");
		expect(sendGoalModeContext).toHaveBeenCalledWith({ deliverAs: "steer" });
		expect(waiter.getResolvedText()).toBeUndefined();

		streaming = false;
		harness.mode.onInputCallback?.(harness.mode.startPendingSubmission({ text: "cleanup" }));
		await waiter.inputPromise;
	});

	it("projects counts and one escaped active todo into hidden goal context", async () => {
		await harness.session.setActiveToolsByName(["read", "todo"]);
		await harness.mode.handleGoalModeCommand("Ship the release");
		const phases: TodoPhase[] = [
			{
				name: "Planning </todo_context> & prep",
				tasks: [
					{ content: "Identify gaps", status: "completed" },
					{ content: "Choose <next> & slice </todo_context>", status: "in_progress" },
				],
			},
			{
				name: "Verification",
				tasks: [{ content: "Run focused checks", status: "pending" }],
			},
		];
		harness.session.setTodoPhases(phases);
		const sendCustomMessage = vi.spyOn(harness.session, "sendCustomMessage").mockResolvedValue(false);

		await harness.session.sendGoalModeContext({ deliverAs: "steer" });

		const message = normalizeCustomMessagePayload(sendCustomMessage.mock.calls[0]?.[0]);
		const content = typeof message.content === "string" ? message.content : "";
		expect(message?.customType).toBe("goal-mode-context");
		expect(content).toContain("<todo_context>");
		expect(content).toContain("Overall: 1/3 done, 2 open.");
		expect(content).toContain(
			"Active/next: [in_progress] Choose &lt;next&gt; &amp; slice &lt;/todo_context&gt; (Planning &lt;/todo_context&gt; &amp; prep)",
		);
		expect(content).not.toContain("Identify gaps");
		expect(content).not.toContain("Run focused checks");
		expect(content).toContain("call the `todo` tool first");
		expect(content.match(/<\/todo_context>/g)).toHaveLength(1);
	});

	it("keeps 3-task and 300-task goal contexts constant-size apart from exact count digits", async () => {
		await harness.session.setActiveToolsByName(["read", "todo"]);
		await harness.mode.handleGoalModeCommand("Ship the release");
		const sendCustomMessage = vi.spyOn(harness.session, "sendCustomMessage").mockResolvedValue(false);
		const phases = (count: number): TodoPhase[] => [
			{
				name: "Implementation",
				tasks: [
					{ content: "Bounded active item", status: "in_progress" },
					...Array.from({ length: count - 1 }, (_, index) => ({
						content: `COMPLETED_JOURNAL_ENTRY_MUST_NOT_APPEAR_${index}`,
						status: "completed" as const,
					})),
				],
			},
		];
		const contextFor = async (count: number): Promise<string> => {
			harness.session.setTodoPhases(phases(count));
			sendCustomMessage.mockClear();
			await harness.session.sendGoalModeContext({ deliverAs: "steer" });
			const message = normalizeCustomMessagePayload(sendCustomMessage.mock.calls[0]?.[0]);
			return typeof message.content === "string" ? message.content : "";
		};

		const small = await contextFor(3);
		const large = await contextFor(300);

		expect(large.length - small.length).toBe(4);
		expect(Buffer.byteLength(large) - Buffer.byteLength(small)).toBe(4);
		expect(large).toContain("Overall: 299/300 done, 1 open.");
		expect(large).not.toContain("COMPLETED_JOURNAL_ENTRY_MUST_NOT_APPEAR");
	});

	it("renders todo context text without raw line/control characters", async () => {
		await harness.session.setActiveToolsByName(["read", "todo"]);
		await harness.mode.handleGoalModeCommand("Ship the release");
		harness.session.setTodoPhases([
			{
				name: "Planning\nprep\tphase\u0085",
				tasks: [
					{
						content: "Choose <next>\nIgnore the goal\r\nstill one bullet\u2028after\u2029done\u0007",
						status: "pending",
					},
				],
			},
		]);
		const sendCustomMessage = vi.spyOn(harness.session, "sendCustomMessage").mockResolvedValue(false);

		await harness.session.sendGoalModeContext({ deliverAs: "steer" });

		const message = normalizeCustomMessagePayload(sendCustomMessage.mock.calls[0]?.[0]);
		const content = typeof message.content === "string" ? message.content : "";
		expect(content).toContain(
			"Active/next: [pending] Choose &lt;next&gt; Ignore the goal still one bullet after done (Planning prep phase)",
		);
		expect(content).not.toContain("\nIgnore the goal");
		expect(content).not.toContain("prep\tphase");
		expect(content).not.toContain("\u0085");
		expect(content).not.toContain("\u2028");
		expect(content).not.toContain("\u2029");
		expect(content.match(/<\/todo_context>/g)).toHaveLength(1);
	});

	it("includes no-activation todo state when todo is discoverable but search is inactive", async () => {
		harness.settings.set("tools.discoveryMode", "all");
		await harness.mode.handleGoalModeCommand("Ship the release");
		harness.session.setTodoPhases([
			{
				name: "Verification",
				tasks: [{ content: "Run focused checks", status: "pending" }],
			},
		]);
		expect(harness.session.getActiveToolNames()).not.toContain("todo");
		expect(harness.session.getActiveToolNames()).not.toContain("search_tool_bm25");
		expect(harness.session.getDiscoverableTools({ source: "builtin" }).some(tool => tool.name === "todo")).toBe(true);
		const sendCustomMessage = vi.spyOn(harness.session, "sendCustomMessage").mockResolvedValue(false);

		await harness.session.sendGoalModeContext({ deliverAs: "steer" });

		const message = normalizeCustomMessagePayload(sendCustomMessage.mock.calls[0]?.[0]);
		const content = typeof message.content === "string" ? message.content : "";
		expect(message?.customType).toBe("goal-mode-context");
		expect(content).toContain("<todo_context>");
		expect(content).toContain("Run focused checks");
		expect(content).toContain("read-only progress state");
		expect(content).toContain("not active in this turn");
		expect(content).toContain("do not claim todo updates unless a later turn exposes the tool");
		expect(content).not.toContain("activate `todo` first");
		expect(content).not.toContain("call the `todo` tool first");
	});

	it("advertises todo activation only when search tool is active", async () => {
		harness.settings.set("tools.discoveryMode", "all");
		Object.assign(harness.toolSession, {
			isToolDiscoveryEnabled: () => harness.session.isToolDiscoveryEnabled(),
			getSelectedDiscoveredToolNames: () => harness.session.getSelectedDiscoveredToolNames(),
			activateDiscoveredTools: (toolNames: string[]) => harness.session.activateDiscoveredTools(toolNames),
			getDiscoverableTools: (filter?: { source?: DiscoverableTool["source"] }) =>
				harness.session.getDiscoverableTools(filter),
		});
		for (const tool of await createTools(harness.toolSession, ["search_tool_bm25"])) {
			harness.toolRegistry.set(tool.name, tool);
		}
		await harness.session.setActiveToolsByName(["read", "search_tool_bm25"]);
		await harness.mode.handleGoalModeCommand("Ship the release");
		harness.session.setTodoPhases([
			{
				name: "Verification",
				tasks: [{ content: "Run focused checks", status: "pending" }],
			},
		]);
		expect(harness.session.getActiveToolNames()).not.toContain("todo");
		expect(harness.session.getActiveToolNames()).toContain("search_tool_bm25");
		const sendCustomMessage = vi.spyOn(harness.session, "sendCustomMessage").mockResolvedValue(false);

		await harness.session.sendGoalModeContext({ deliverAs: "steer" });

		const message = normalizeCustomMessagePayload(sendCustomMessage.mock.calls[0]?.[0]);
		const content = typeof message.content === "string" ? message.content : "";
		expect(message?.customType).toBe("goal-mode-context");
		expect(content).toContain("<todo_context>");
		expect(content).toContain("Run focused checks");
		expect(content).toContain("read-only progress state");
		expect(content).toContain("discoverable but not active");
		expect(content).toContain("call `search_tool_bm25` to activate `todo` first");
		expect(content).not.toContain("do not claim todo updates unless a later turn exposes the tool");
	});

	it("omits persisted todo state when todo tool is inactive", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		harness.session.setTodoPhases([
			{
				name: "Verification",
				tasks: [{ content: "Run focused checks", status: "pending" }],
			},
		]);
		const sendCustomMessage = vi.spyOn(harness.session, "sendCustomMessage").mockResolvedValue(false);

		await harness.session.sendGoalModeContext({ deliverAs: "steer" });

		const message = normalizeCustomMessagePayload(sendCustomMessage.mock.calls[0]?.[0]);
		const content = typeof message.content === "string" ? message.content : "";
		expect(message?.customType).toBe("goal-mode-context");
		expect(content).not.toContain("<todo_context>");
		expect(content).not.toContain("Run focused checks");
	});

	it("drops a goal continuation tick while the agent is streaming", async () => {
		// Repro for the race the streaming guard on /goal set X exposed: the
		// 800ms continuation timer armed by getUserInput() can outlive the idle
		// window when streaming starts between schedule and fire (e.g. /goal set
		// taking the streaming branch, or any extension that triggers a turn).
		// Without the streaming-aware guard the timer fires onInputCallback
		// with a `goal-continuation` and submitInteractiveInput resurfaces
		// AgentBusyError via promptCustomMessage. Driven with fake timers so the
		// 800ms window is exercised deterministically without a real wall-clock wait.
		await harness.mode.handleGoalModeCommand("Ship the release");

		vi.useFakeTimers();
		const waiter = await armInputWaiter(harness.mode);

		let streaming = true;
		Object.defineProperty(harness.session, "isStreaming", { configurable: true, get: () => streaming });

		// Fire the armed 800ms continuation timer while streaming is true.
		vi.advanceTimersByTime(800);
		await waitForMicrotasks();

		expect(waiter.getResolvedText()).toBeUndefined();

		streaming = false;
		harness.mode.onInputCallback?.(harness.mode.startPendingSubmission({ text: "cleanup" }));
		await waiter.inputPromise;
	});

	it("pauses after a visible no-tool user turn and resumes only after user-driven tool work", async () => {
		await harness.mode.init({ suppressWelcomeIntro: true });
		await harness.mode.handleGoalModeCommand("Ship the release");
		const userMessage = (text: string) => ({
			role: "user" as const,
			content: [{ type: "text" as const, text }],
			timestamp: Date.now(),
		});
		const emit = (event: AgentEvent) => harness.session.agent.emitExternalEvent(event);
		const deliver = async (event: AgentEvent): Promise<void> => {
			const delivered = Promise.withResolvers<void>();
			const unsubscribe = harness.session.subscribe(received => {
				if (received.type === event.type) delivered.resolve();
			});
			emit(event);
			await delivered.promise;
			unsubscribe();
			await waitForMicrotasks();
		};
		const settle = async (): Promise<void> => {
			const ended = Promise.withResolvers<void>();
			const unsubscribe = harness.session.subscribe(event => {
				if (event.type === "agent_end") ended.resolve();
			});
			emit({ type: "agent_end", messages: [] });
			await ended.promise;
			await harness.session.waitForIdle();
			unsubscribe();
			await waitForMicrotasks();
		};
		const buildContinuation = vi.spyOn(harness.session.goalRuntime, "buildContinuationPrompt");
		const pauseInput = await armInputWaiter(harness.mode);
		expect(buildContinuation).toHaveBeenCalledTimes(1);
		buildContinuation.mockClear();

		const pausedSubmission = harness.mode.startPendingSubmission({ text: "Pause here" });
		harness.mode.onInputCallback?.(pausedSubmission);
		await pauseInput.inputPromise;
		expect(pauseInput.getResolvedText()).toBe("Pause here");
		await deliver({ type: "agent_start" });
		await deliver({ type: "message_start", message: userMessage("Pause here") });
		await settle();
		harness.mode.finishPendingSubmission(pausedSubmission);

		buildContinuation.mockClear();
		const resumeInput = await armInputWaiter(harness.mode);
		expect(buildContinuation).not.toHaveBeenCalled();
		expect(resumeInput.getResolvedText()).toBeUndefined();

		const resumedSubmission = harness.mode.startPendingSubmission({ text: "Resume the work" });
		harness.mode.onInputCallback?.(resumedSubmission);
		await resumeInput.inputPromise;
		expect(resumeInput.getResolvedText()).toBe("Resume the work");
		await deliver({ type: "agent_start" });
		await deliver({ type: "message_start", message: userMessage("Resume the work") });
		await deliver({
			type: "tool_execution_start",
			toolCallId: "read-1",
			toolName: "read",
			args: { path: "README.md" },
		});
		await settle();
		harness.mode.finishPendingSubmission(resumedSubmission);
		expect(harness.mode.goalModeEnabled).toBe(true);
		expect(harness.mode.goalModePaused).toBe(false);
		expect(harness.session.getGoalModeState()?.goal.status).toBe("active");
		expect(harness.settings.get("goal.continuationModes")).toContain("interactive");

		buildContinuation.mockClear();
		void harness.mode.getUserInput();
		await waitForMicrotasks();
		expect(buildContinuation).toHaveBeenCalledTimes(1);
	});

	it("refuses /goal while plan mode is active", async () => {
		const showWarning = vi.spyOn(harness.mode, "showWarning");
		harness.mode.planModeEnabled = true;

		await harness.mode.handleGoalModeCommand("Ship the release");

		expect(showWarning).toHaveBeenCalledWith("Exit plan mode first.");
		expect(harness.session.getGoalModeState()).toBeUndefined();
	});

	it("refuses /plan while goal mode is active", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		const showWarning = vi.spyOn(harness.mode, "showWarning");

		await harness.mode.handlePlanModeCommand();

		expect(showWarning).toHaveBeenCalledWith("Exit goal mode first.");
		expect(harness.mode.planModeEnabled).toBe(false);
	});

	it("rejects a new /goal objective while paused", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		vi.spyOn(harness.mode, "showHookSelector").mockResolvedValue("Pause");
		await harness.mode.handleGoalModeCommand();
		const showWarning = vi.spyOn(harness.mode, "showWarning");

		await harness.mode.handleGoalModeCommand("Replace the objective");

		expect(showWarning).toHaveBeenCalledWith(
			"Resume the current goal first, or drop it before setting a new objective.",
		);
		expect(harness.session.getGoalModeState()?.enabled).toBe(false);
		expect(harness.session.getGoalModeState()?.goal.objective).toBe("Ship the release");
		expect(harness.session.getGoalModeState()?.goal.status).toBe("paused");
	});

	it("resumes the paused goal via the bare /goal menu", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		const selector = vi.spyOn(harness.mode, "showHookSelector").mockResolvedValueOnce("Pause");
		await harness.mode.handleGoalModeCommand();
		expect(harness.mode.goalModePaused).toBe(true);
		selector.mockResolvedValueOnce("Resume");
		const showStatus = vi.spyOn(harness.mode, "showStatus");

		await harness.mode.handleGoalModeCommand();

		expect(showStatus).toHaveBeenCalledWith("Goal mode resumed.");
		expect(harness.mode.goalModeEnabled).toBe(true);
		expect(harness.mode.goalModePaused).toBe(false);
		expect(harness.session.getGoalModeState()?.enabled).toBe(true);
		expect(harness.session.getGoalModeState()?.goal.objective).toBe("Ship the release");
		expect(harness.session.getGoalModeState()?.goal.status).toBe("active");
		expect(await toolNamesFor(harness)).toContain("goal");
	});

	it("never mutates or offers goal budgets through /goal", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		const goal = harness.session.getGoalModeState()?.goal;
		if (!goal) throw new Error("expected active goal");
		goal.tokenBudget = 50;
		goal.tokensUsed = 42;

		for (const enabled of [false, true]) {
			harness.settings.set("goal.modelBudgetsEnabled", enabled);
			await harness.mode.handleGoalModeCommand("budget 123");
			expect(harness.session.getGoalModeState()?.goal.tokenBudget).toBe(50);
			expect(harness.session.getGoalModeState()?.goal.tokensUsed).toBe(42);

			const selector = vi.spyOn(harness.mode, "showHookSelector").mockResolvedValueOnce(undefined);
			await harness.mode.handleGoalModeCommand();
			expect(selector).toHaveBeenLastCalledWith(expect.any(String), ["Show details", "Pause", "Drop"]);
			selector.mockRestore();
		}
	});

	it("returns the completion report from the goal tool and exits goal mode before the next turn rebuild", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		harness.settings.set("goal.modelBudgetsEnabled", true);
		await harness.session.goalRuntime.onBudgetMutated(50);
		const appendCustomEntry = vi.spyOn(harness.session.sessionManager, "appendCustomEntry");
		const goalTool = (await createTools(harness.toolSession, harness.session.getActiveToolNames())).find(
			tool => tool.name === "goal",
		);
		if (!goalTool) {
			throw new Error("Expected goal tool to be active");
		}

		const result = await goalTool.execute("call-1", { op: "complete" });
		const completionText = JSON.stringify(result.content);

		expect(result.details?.completionBudgetReport).toBe(
			"Goal achieved. Report final budget usage to the user: tokens used: 0 of 50.",
		);
		expect(completionText).toContain("Goal achieved. Report final budget usage to the user: tokens used: 0 of 50.");
		expect(harness.session.getGoalModeState()?.mode).toBe("exiting");
		// Per fix #1: completeGoalFromTool clears state.enabled so subsequent createTools
		// calls (e.g. mid-turn refreshes) no longer advertise the goal tool. The model's
		// existing toolset for the in-flight turn is unaffected — what we care about here
		// is that the next createTools observation reflects the deactivation.
		expect(harness.session.getGoalModeState()?.enabled).toBe(false);
		expect(await toolNamesFor(harness)).not.toContain("goal");

		const nextTurn = harness.mode.getUserInput();
		// getUserInput observes mode === "exiting" and awaits #exitGoalMode before
		// arming onInputCallback. Drain microtasks until that side-effect lands.
		for (let i = 0; i < 100 && harness.session.getGoalModeState() !== undefined; i++) {
			await Bun.sleep(0);
		}
		expect(harness.mode.goalModeEnabled).toBe(false);
		expect(harness.mode.goalModePaused).toBe(false);
		expect(harness.session.getGoalModeState()).toBeUndefined();
		expect(await toolNamesFor(harness)).not.toContain("goal");
		expect(appendCustomEntry).toHaveBeenCalledWith(
			"goal-completed",
			expect.objectContaining({
				objective: "Ship the release",
				tokenBudget: 50,
				tokensUsed: 0,
			}),
		);

		harness.mode.onInputCallback?.(harness.mode.startPendingSubmission({ text: "next turn" }));
		await nextTurn;
	});

	/**
	 * GMI-4b: `openGoalDetail` (the down-arrow affordance's target) must open the
	 * SAME runtime-wired goal menu `/goal` opens — real objective in the title,
	 * the exact action list for the goal's actual state — and Esc must close it
	 * exactly once with zero side effects. Locks out two regressions: a menu that
	 * shows stale/placeholder goal data, and an Esc that re-opens the selector or
	 * fires a default action (pausing/dropping the goal the operator only peeked at).
	 */
	describe("openGoalDetail menu", () => {
		it("opens the active-goal menu with the real objective, status, and action list", async () => {
			await harness.mode.handleGoalModeCommand("Ship the release");
			const selector = vi.spyOn(harness.mode, "showHookSelector").mockResolvedValue(undefined);

			await harness.mode.openGoalDetail();

			expect(selector).toHaveBeenCalledTimes(1);
			expect(selector).toHaveBeenCalledWith("Goal: Ship the release (active)", ["Show details", "Pause", "Drop"]);
		});

		it("Esc closes the menu exactly once and mutates nothing", async () => {
			await harness.mode.handleGoalModeCommand("Ship the release");
			const before = harness.session.getGoalModeState();
			const selector = vi.spyOn(harness.mode, "showHookSelector").mockResolvedValue(undefined);

			await harness.mode.openGoalDetail();
			await waitForMicrotasks();

			// One open, no reopen, and the dismissal ran no action: the goal is
			// byte-identical and still active.
			expect(selector).toHaveBeenCalledTimes(1);
			expect(harness.mode.goalModeEnabled).toBe(true);
			expect(harness.mode.goalModePaused).toBe(false);
			expect(harness.session.getGoalModeState()).toEqual(before);
		});

		it("opens the paused-goal menu with Resume first when the goal is paused", async () => {
			await harness.mode.handleGoalModeCommand("Ship the release");
			const selector = vi.spyOn(harness.mode, "showHookSelector").mockResolvedValueOnce("Pause");
			await harness.mode.handleGoalModeCommand();
			expect(harness.mode.goalModePaused).toBe(true);
			selector.mockClear();
			selector.mockResolvedValue(undefined);

			await harness.mode.openGoalDetail();

			expect(selector).toHaveBeenCalledTimes(1);
			expect(selector).toHaveBeenCalledWith("Goal paused: Ship the release", ["Resume", "Show details", "Drop"]);
		});

		it("is a strict no-op when no goal exists (never opens an empty menu)", async () => {
			const selector = vi.spyOn(harness.mode, "showHookSelector").mockResolvedValue(undefined);

			await harness.mode.openGoalDetail();

			expect(selector).not.toHaveBeenCalled();
		});

		it("routes a menu choice to the real action (Pause pauses the actual goal)", async () => {
			await harness.mode.handleGoalModeCommand("Ship the release");
			vi.spyOn(harness.mode, "showHookSelector").mockResolvedValueOnce("Pause");

			await harness.mode.openGoalDetail();

			expect(harness.mode.goalModeEnabled).toBe(false);
			expect(harness.mode.goalModePaused).toBe(true);
			expect(harness.session.getGoalModeState()?.goal.status).toBe("paused");
		});
	});
});
