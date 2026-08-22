/**
 * WHY: an active goal stopped driving after a provider hiccup the session had already recovered
 * from. The footline still read `Goal`, the status line said "Recovered after 2 retries (1.5s
 * waiting) · provider hiccup", and then nothing happened until a human typed "keep going".
 *
 * Two mechanisms, both in `#handleGoalSessionEvent`, both about a turn the transport killed:
 *
 *   1. A RETRY LOOKED LIKE A NEW TURN. `#handleRetryableError` resumes the work with a fresh
 *      `agent_start`, and the handler reset `#goalTurnHadToolCalls` on every one. A continuation
 *      that called tools and then died came back as a retried attempt that only talked, so the
 *      decision `#goalSuppressNextContinuation = !#goalTurnHadToolCalls` read the turn as "the
 *      model has nothing left to do" and the goal stood down mid-work. The killed attempt's own
 *      `agent_end` never reaches the mode at all — it is held while the prompt is in flight and
 *      superseded by the recovery — so `auto_retry_start` is the only notice that the next
 *      `agent_start` is the same turn resuming.
 *   2. A KILLED TURN DECIDED THE GOAL'S FATE. When the retries were spent, the mode did see an
 *      `agent_end` whose last assistant message carried `stopReason: "error"`, and finalized the
 *      same decision from it. A turn that never got to call anything fails that test by
 *      construction, so one exhausted hiccup latched suppression permanently: nothing but a
 *      visible user turn clears the latch.
 *
 * The class this closes: a turn the provider killed decides nothing about whether the goal keeps
 * driving. Tool-call evidence survives into the retry of the same turn, suppression is derived
 * only from a turn that ended on its own terms, and the tolerance for killed turns is BOUNDED and
 * REPORTED so a provider that is genuinely gone cannot spin the goal forever.
 *
 * What it does not catch: a fault that produces no `agent_end` at all (the process dies), a goal
 * paused through the abort path (`onTaskAborted`), or a stall whose cause is upstream of the mode
 * — a continuation the session refuses to run rather than one the mode declines to schedule.
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
import { InteractiveMode } from "@veyyon/coding-agent/modes/interactive-mode";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { SubmittedUserInput } from "@veyyon/coding-agent/modes/types";
import { AgentSession, type AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";

/** A transport fault the retry machinery treats as transient — the "provider hiccup" of the report. */
const TRANSIENT_FAULT = "Error Code stream_read_error: stream_read_error";

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

describe("a goal keeps driving across a provider hiccup it recovered from", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let warnings: string[];
	let stopReasons: Array<AssistantMessage["stopReason"] | undefined>;
	let mock: { calls: unknown[] };

	beforeAll(() => {
		initTheme();
	});

	/**
	 * A real session over a mock provider, with the mode's goal subscription installed by
	 * `init()`. `responses` is the provider script: one entry per model call, so a `throw`
	 * followed by content is exactly one killed attempt and its retry.
	 */
	const build = async (responses: MockResponseScript[], overrides: Record<string, unknown> = {}): Promise<void> => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-goal-hiccup-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const model = getBundledModel("openai", "gpt-5");
		if (!model) throw new Error("Expected bundled openai/gpt-5 test model");

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": false,
			"goal.enabled": true,
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
		mock = scripted;
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
		await mode.init({ suppressWelcomeIntro: true });
		// The production path a `/goal` or a goal-tool create takes, so the mode learns about the
		// goal the way it does in a session rather than from a field poke.
		await session.goalRuntime.createGoal({ objective: "Ship the release" });
		await flushMicrotasks();
	};

	/**
	 * Arm the composer the way the interactive loop does and let the 800ms continuation timer
	 * fire. Returns the submission goal mode made, or `undefined` when it made none — which is
	 * exactly the stall being tested, so the composer is disarmed again either way.
	 */
	const awaitContinuation = async (): Promise<SubmittedUserInput | undefined> => {
		vi.useFakeTimers();
		const submitted: SubmittedUserInput[] = [];
		void mode.getUserInput().then(input => submitted.push(input));
		await flushMicrotasks();
		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		vi.useRealTimers();
		if (submitted.length === 0) mode.onInputCallback = undefined;
		return submitted.at(0);
	};

	/** The interactive loop's own submit path, so the turn is a real goal-continuation turn. */
	const runSubmission = async (input: SubmittedUserInput): Promise<void> => {
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

	it("keeps the tool-call evidence a killed attempt already earned", async () => {
		// The reported shape. The continuation turn calls a tool, the transport dies, the
		// session retries, and the retried attempt only talks. The session's retry SUPERSEDES
		// the killed attempt's `agent_end` (held while the prompt is in flight), so the only
		// notice the mode gets that the turn was resumed is `auto_retry_start` followed by a
		// second `agent_start` — and that second start used to wipe the tool-call evidence the
		// dead attempt had already earned, which read as "the model has nothing left to do".
		await build([
			{ content: [{ type: "toolCall", id: "tc-1", name: "note", arguments: {} }] },
			{ throw: TRANSIENT_FAULT },
			{ content: ["talked only"], stopReason: "stop" },
			{ content: ["and again"], stopReason: "stop" },
		]);

		const first = await awaitContinuation();
		if (!first) throw new Error("Expected goal mode to open its first continuation turn");
		await runSubmission(first);
		// One settle reaches the mode, and it is the recovery, not the fault.
		expect(stopReasons).toEqual(["stop"]);

		expect((await awaitContinuation())?.customType).toBe("goal-continuation");
		expect(warnings).toEqual([]);
	});

	/** Control: a retry that itself does the work needs no evidence carried across. */
	it("drives another continuation when the retried attempt is the one that calls a tool", async () => {
		await build([
			{ throw: TRANSIENT_FAULT },
			{ content: [{ type: "toolCall", id: "tc-1", name: "note", arguments: {} }] },
			{ content: ["kept going"], stopReason: "stop" },
			{ content: [{ type: "toolCall", id: "tc-2", name: "note", arguments: {} }] },
			{ content: ["still going"], stopReason: "stop" },
		]);

		const first = await awaitContinuation();
		expect(first?.customType).toBe("goal-continuation");
		if (!first) throw new Error("Expected goal mode to open its first continuation turn");
		await runSubmission(first);
		expect(stopReasons).toEqual(["stop"]);

		expect((await awaitContinuation())?.customType).toBe("goal-continuation");
	});

	it("still stands down after a continuation turn that ended cleanly with nothing but prose", async () => {
		// The designed suppression is untouched: a turn that ENDED and called nothing is the
		// model saying it has no more work, and goal mode waits for the operator.
		await build([{ content: ["nothing left to do"], stopReason: "stop" }]);

		const first = await awaitContinuation();
		if (!first) throw new Error("Expected goal mode to open its first continuation turn");
		await runSubmission(first);
		expect(stopReasons).toEqual(["stop"]);

		expect(await awaitContinuation()).toBeUndefined();
		expect(warnings).toEqual([]);
	});

	it("stops driving and says so once three consecutive turns die, instead of retrying forever", async () => {
		await build([{ throw: TRANSIENT_FAULT }, { throw: TRANSIENT_FAULT }, { throw: TRANSIENT_FAULT }], {
			"retry.maxRetries": 0,
		});

		for (let attempt = 1; attempt <= 3; attempt += 1) {
			const input = await awaitContinuation();
			expect(input?.customType).toBe("goal-continuation");
			if (!input) throw new Error(`Expected goal mode to open continuation turn ${attempt}`);
			await runSubmission(input);
		}

		expect(stopReasons).toEqual(["error", "error", "error"]);
		expect(mock.calls).toHaveLength(3);
		// The bound terminates: no fourth turn, and the operator is told why the goal went quiet.
		expect(await awaitContinuation()).toBeUndefined();
		expect(warnings).toEqual(["Goal mode stopped driving after 3 failed turns. Send a message to resume it."]);
	});

	it("counts only CONSECUTIVE deaths, so a turn that lands clears the tally", async () => {
		// Two deaths, a working turn, then two more deaths: five error-or-recovered turns and
		// the bound is still not reached, because the working turn reset it. A tally that never
		// resets would stand the goal down in the middle of a session that is making progress.
		await build(
			[
				{ throw: TRANSIENT_FAULT },
				{ throw: TRANSIENT_FAULT },
				{ content: [{ type: "toolCall", id: "tc-1", name: "note", arguments: {} }] },
				{ content: ["worked"], stopReason: "stop" },
				{ throw: TRANSIENT_FAULT },
				{ throw: TRANSIENT_FAULT },
			],
			{ "retry.maxRetries": 0 },
		);

		for (let turn = 1; turn <= 5; turn += 1) {
			const input = await awaitContinuation();
			expect(input?.customType).toBe("goal-continuation");
			if (!input) throw new Error(`Expected goal mode to open continuation turn ${turn}`);
			await runSubmission(input);
		}

		expect(stopReasons).toEqual(["error", "error", "stop", "error", "error"]);
		expect(warnings).toEqual([]);
	});

	it("resumes driving when the operator sends a message after the bound stopped it", async () => {
		await build(
			[
				{ throw: TRANSIENT_FAULT },
				{ throw: TRANSIENT_FAULT },
				{ throw: TRANSIENT_FAULT },
				{ content: [{ type: "toolCall", id: "tc-1", name: "note", arguments: {} }] },
				{ content: ["back to work"], stopReason: "stop" },
				{ throw: TRANSIENT_FAULT },
				{ content: [{ type: "toolCall", id: "tc-2", name: "note", arguments: {} }] },
				{ content: ["still working"], stopReason: "stop" },
			],
			{ "retry.maxRetries": 0 },
		);

		for (let turn = 1; turn <= 3; turn += 1) {
			const input = await awaitContinuation();
			if (!input) throw new Error(`Expected goal mode to open continuation turn ${turn}`);
			await runSubmission(input);
		}
		expect(await awaitContinuation()).toBeUndefined();
		expect(warnings).toHaveLength(1);

		// What the warning tells the operator to do, done: a visible user turn that resumes
		// execution clears the stand-down.
		await submitInteractiveInput(mode, session, mode.startPendingSubmission({ text: "keep going" }));
		await session.waitForIdle();
		await flushMicrotasks();

		const resumed = await awaitContinuation();
		expect(resumed?.customType).toBe("goal-continuation");
		if (!resumed) throw new Error("Expected goal mode to drive again after the operator's turn");
		// And the tally went with it: one death after the resume is the FIRST death again, not
		// the fourth, so the goal keeps driving instead of standing down a second time.
		await runSubmission(resumed);
		expect(stopReasons.at(-1)).toBe("error");
		expect((await awaitContinuation())?.customType).toBe("goal-continuation");
		expect(warnings).toHaveLength(1);
	});
});
