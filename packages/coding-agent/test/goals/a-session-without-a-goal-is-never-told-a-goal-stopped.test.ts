/**
 * WHY: a session that had never enabled goal mode showed
 * "Goal mode stopped driving after 3 failed turns. Send a message to resume it."
 *
 * `#handleGoalSessionEvent` is subscribed unconditionally — `#subscribeToGoalSessionEvents()`
 * installs it for EVERY session, not only a goal-driven one. Its `agent_end` branch incremented
 * `#goalFailedTurns` and raised the stand-down warning with no check that a goal was running, so
 * three consecutive provider-killed turns in an ordinary session announced that a goal nobody had
 * started had given up. The action was already guarded — `#goalContinuationBlock` returns
 * "goal-mode-off" — which is why nothing else was visibly wrong: only the message escaped.
 *
 * The second defect is the same counter from the other side. `#goalFailedTurns` was never cleared
 * when a goal STARTED, and the `activating` branch cleared only the two suppression booleans. A
 * session that had already banked failures entered goal mode mid-count and stood the goal down on
 * its first error instead of its third.
 *
 * The class this closes: the failed-turn counter and its warning belong to an ACTIVE goal, and a
 * goal begins its life on a clean slate. A turn that fails while no goal is running is not a goal
 * failure and cannot be banked against a goal that starts later.
 *
 * What it does not catch: a warning raised from a path other than the failed-turn counter (the
 * busy-timeout stand-down in `#armGoalContinuation` is guarded separately, by the same
 * `#goalContinuationBlock`), and a fault that produces no `agent_end` at all.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { submitInteractiveInput } from "@veyyon/coding-agent/main";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import type { SubmittedUserInput } from "@veyyon/coding-agent/modes/terminal/types";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { AuthStorage } from "@veyyon/kernel/session/auth-storage";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";

/** A transport fault the retry machinery treats as transient. */
const TRANSIENT_FAULT = "Error Code stream_read_error: stream_read_error";

/**
 * One turn the provider kills for good: the initial call plus the single retry
 * `retry.maxRetries: 1` allows, so the turn settles with `stopReason: "error"`.
 */
const KILLED_TURN = [{ throw: TRANSIENT_FAULT }, { throw: TRANSIENT_FAULT }];

/** The stand-down message this suite exists to keep out of a goal-less session. */
const STAND_DOWN = /Goal mode stopped driving/;

interface MockResponseScript {
	content?: ReadonlyArray<
		string | { type: "toolCall"; id?: string; name: string; arguments: Record<string, unknown> }
	>;
	stopReason?: "stop" | "toolUse";
	throw?: string;
}

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe("the goal stand-down warning belongs to a goal that is actually running", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let warnings: string[];
	let stopReasons: Array<AssistantMessage["stopReason"] | undefined>;

	beforeAll(() => {
		initTheme();
	});

	/**
	 * A real session over a mock provider with the mode's goal subscription installed by `init()`.
	 * No goal is created here: every test in this suite is about what the counter does BEFORE one
	 * exists, so the goal (when a test wants one) is created mid-session through the runtime.
	 */
	const build = async (responses: MockResponseScript[], overrides: Record<string, unknown> = {}): Promise<void> => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-goalless-warning-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const model = getBundledModel("openai", "gpt-5");
		if (!model) throw new Error("Expected bundled openai/gpt-5 test model");

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": false,
			"goal.continuationModes": ["interactive"],
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 50,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
			"todo.enabled": false,
			"todo.reminders": false,
			...overrides,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		const noteTool: AgentTool = {
			name: "note",
			label: "Note",
			description: "Record a note",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "noted" }] }),
		};

		const scripted = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "openai-test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [noteTool], messages: [] },
			streamFn: (requestedModel, context, options) => scripted.stream(requestedModel, context, options),
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[noteTool.name, noteTool]]),
			builtInToolNames: ["note", "goal"],
		});

		// Retry delays are the provider's business, not this contract's.
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		stopReasons = [];
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type !== "agent_end") return;
			const last = [...event.messages]
				.reverse()
				.find((message): message is AssistantMessage => message.role === "assistant");
			stopReasons.push(last?.stopReason);
		});

		mode = new InteractiveMode(session, "test");
		vi.spyOn(mode, "addMessageToChat").mockReturnValue([]);
		vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
		warnings = [];
		vi.spyOn(mode, "showWarning").mockImplementation(message => {
			warnings.push(message);
		});
		mode.ui.requestRender = vi.fn();
		await mode.init();
		await flushMicrotasks();
	};

	/**
	 * An ordinary visible user turn, submitted through the interactive loop's own path.
	 * `started: true` is the "already registered" branch of `submitInteractiveInput`: without it
	 * the submission needs a composer-registered pending entry and returns before prompting.
	 */
	const runUserTurn = async (text: string): Promise<void> => {
		const input: SubmittedUserInput = { text, cancelled: false, started: true };
		await submitInteractiveInput(mode, session, input);
		await session.waitForIdle();
		await flushMicrotasks();
	};

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(async () => {
		mode?.stop();
		vi.useRealTimers();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	// The reported shape: goal mode never enabled, three consecutive provider-killed turns.
	it("says nothing about a goal when three turns fail and no goal was ever started", async () => {
		await build([...KILLED_TURN, ...KILLED_TURN, ...KILLED_TURN], { "goal.enabled": false });

		await runUserTurn("first");
		await runUserTurn("second");
		await runUserTurn("third");

		// Without this the suite could pass by never failing a turn at all.
		expect(stopReasons).toEqual(["error", "error", "error"]);
		expect(warnings.filter(warning => STAND_DOWN.test(warning))).toEqual([]);
	});

	// Control: the stand-down is a real feature and must still fire for a goal that IS driving.
	it("still stands a running goal down on its third consecutive failed turn", async () => {
		await build([...KILLED_TURN, ...KILLED_TURN, ...KILLED_TURN], { "goal.enabled": true });
		await session.goalRuntime.createGoal({ objective: "Ship the release" });
		await flushMicrotasks();

		await runUserTurn("first");
		await runUserTurn("second");
		await runUserTurn("third");

		expect(stopReasons).toEqual(["error", "error", "error"]);
		expect(warnings.filter(warning => STAND_DOWN.test(warning))).toEqual([
			"Goal mode stopped driving after 3 failed turns. Send a message to resume it.",
		]);
	});

	/**
	 * The fragility half. The guard above means a turn can only be banked while a goal is running,
	 * so the stale count that matters is one an EARLIER goal left behind: `#exitGoalMode` clears
	 * `goalModeEnabled` and nothing else, so without the reset the next goal inherits its
	 * predecessor's failures and stands down on its first error instead of its third.
	 */
	it("gives a new goal its full tolerance when an earlier goal already banked failures", async () => {
		await build([...KILLED_TURN, ...KILLED_TURN, ...KILLED_TURN], { "goal.enabled": true });
		await session.goalRuntime.createGoal({ objective: "Ship the release" });
		await flushMicrotasks();

		await runUserTurn("first");
		await runUserTurn("second");

		// The first goal ends carrying two failed turns.
		await session.goalRuntime.dropGoal();
		await flushMicrotasks();

		// A second goal starts. Its tolerance is its own, not what its predecessor spent.
		await session.goalRuntime.createGoal({ objective: "Ship the next release" });
		await flushMicrotasks();

		await runUserTurn("third");

		expect(stopReasons).toEqual(["error", "error", "error"]);
		expect(warnings.filter(warning => STAND_DOWN.test(warning))).toEqual([]);
	});
});
