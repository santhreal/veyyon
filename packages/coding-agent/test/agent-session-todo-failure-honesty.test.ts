import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { AssistantMessage, TextContent, ToolCall } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { normalizeCustomMessagePayload } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import type { TodoPhase } from "@veyyon/coding-agent/tools/todo";
import { TempDir, withTimeout } from "@veyyon/utils";

/**
 * Three honesty contracts the todo path broke in the field, recorded verbatim
 * in the operator's failure log:
 *
 * 1. After the SAME validation failure twice, the harness kept ordering "call
 *    todo again before continuing". The model could not invent the missing
 *    field, so every retry cost a turn and produced the identical error.
 * 2. The board write never landed, yet a reminder still asserted "You stopped
 *    with 8 incomplete todo item(s)". All eight were in fact complete. A failed
 *    write means the board is unknown, not that work is outstanding.
 * 3. Every reminder re-echoed the whole open list into a context window that
 *    already held it. One echo per context window is the useful amount; the
 *    allowance resets at the compaction boundary, past which the earlier echo
 *    is gone.
 *
 * MUTATION PLAN. Each fix below is neutered one at a time in
 * `src/session/agent-session.ts` (or `src/session/todo-reminder.ts`), the file
 * is run, the named assertions are confirmed red, and the edit is reverted.
 * Anchor by the quoted text, not by line number: the file moves constantly.
 *
 * 1. Instruction swap. In the `toolName === TOOL.todo` branch of the
 *    `message_end` / `toolResult` handler, force the non-repeat arm:
 *      `const repeated = false;`
 *    Red: "stops ordering a retry once the same todo failure repeats" on
 *    `expect(second).not.toContain("call todo again before continuing")`,
 *    plus its "cannot succeed" and "unusable" assertions. The sibling test
 *    "keeps asking for a fix while the failure is a different one" MUST stay
 *    green: it is the negative control proving the swap is not unconditional.
 *
 * 2. Failed-write suppression. In `#checkTodoCompletion`, delete the guard
 *      `if (this.#lastTodoFailureText !== undefined) { ... return false; }`
 *    Red: "says the board may be stale rather than asserting a count after a
 *    failed write" on `expect(reminderAttempts).toEqual([])` and
 *    `expect(continuationReminderTexts()).toEqual([])`, which is exactly the
 *    logged "You stopped with 8 incomplete todo item(s)" against a board that
 *    was never written. The same test's "the recorded board may be stale"
 *    assertion stays green, since that string lives on the error reminder.
 *
 * 3. Per-window echo latch. In `#checkTodoCompletion`, force the echo on:
 *      `const echoFullList = true;`
 *    Red: "echoes the full list once per context window and short-forms the
 *    rest" on `expect(later).toContain("Active/next: ")` for the second
 *    reminder. (Re-verified 2026-08-04: the sibling
 *    `not.toContain("Smoke test release readiness")` on the same loop does NOT
 *    go red, because by then that task is off the board either way. Only the
 *    `Active/next: ` assertion discriminates the short form.)
 *    Then force it off (`const echoFullList = false;`) and
 *    "spends a fresh echo after a compaction boundary" goes red on
 *    `expect(second).not.toContain("Active/next: ")`. Both directions are
 *    needed: one proves the latch closes, the other proves compaction reopens
 *    it, and neither alone distinguishes the latch from a constant.
 *
 * 4. Branch-scoped boundary. Swap the boundary read back to the whole file
 *    (`getLatestCompactionEntry(this.sessionManager.getEntries())`).
 *    Red: "re-echoes after a rewind drops the compaction entry off the active
 *    branch" on `expect(third).not.toContain("Active/next: ")`.
 *
 * 5. Latch lifecycle. Delete `this.#lastTodoFailureText = undefined;` from
 *    `#resetTodoReminderStateForNewContext`.
 *    Red: "clears on a new session, so /new and /clear restore the reminder"
 *    and "clears on a resume" both time out on `todo_reminder never fired`.
 *    "still refuses to assert a count while the failed write is the latest
 *    word" MUST stay green: it is the negative control proving the reset is
 *    scoped to a boundary rather than firing on any stop.
 */
describe("AgentSession todo failure honesty", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let reminderAttempts: number[];
	let firstReminderPromise: Promise<void>;
	let resolveFirstReminder: () => void;

	function assistantStop(text = "paused at your instruction"): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	function emitTextOnlyStop(): void {
		const msg = assistantStop();
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
	}

	/**
	 * Emit one `todo` tool result, failed when `errorText` is a string.
	 *
	 * `details` overrides the default so a caller can emit the shape a call that
	 * never really failed arrives in. Those carry `isError` too, so the details
	 * are the only honest discriminator.
	 */
	function emitTodoResult(
		errorText: string | undefined,
		phases?: TodoPhase[],
		details?: Record<string, unknown>,
	): void {
		const toolCallId = `call_todo_${Date.now()}_${Math.random()}`;
		const toolCall: ToolCall = { type: "toolCall", id: toolCallId, name: "todo", arguments: {} };
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [toolCall],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: {
				input: 50,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 60,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		const content: TextContent[] = [{ type: "text", text: errorText ?? "ok" }];
		session.agent.emitExternalEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId,
				toolName: "todo",
				content,
				isError: errorText !== undefined,
				details: details ?? (phases ? { phases } : {}),
				timestamp: Date.now(),
			},
		});
	}

	/**
	 * Text of every `todo-error-reminder` the session delivered, in order.
	 * Captured at the delivery call rather than from the transcript: a
	 * `nextTurn` message emitted mid-stream is queued and only persisted when
	 * the next turn actually starts, which these tests never reach.
	 */
	let todoErrorReminders: string[];
	function todoErrorReminderTexts(): string[] {
		return todoErrorReminders;
	}

	/** Text of every stop-time continuation reminder, in order. */
	function continuationReminderTexts(): string[] {
		const texts: string[] = [];
		for (const entry of sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "developer") continue;
			const { content } = entry.message;
			if (!Array.isArray(content)) continue;
			for (const item of content) {
				if (item.type === "text" && item.text.includes("Continue working now.")) texts.push(item.text);
			}
		}
		return texts;
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-todo-failure-honesty-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": true,
				"todo.reminders.max": 3,
			}),
			modelRegistry,
		});

		reminderAttempts = [];
		todoErrorReminders = [];
		const sendCustomMessage = session.sendCustomMessage.bind(session);
		vi.spyOn(session, "sendCustomMessage").mockImplementation(async (message, options) => {
			// `CustomMessagePayload` is a union with a bare string, so read it the
			// way the session itself does rather than reaching into one arm.
			const normalized = normalizeCustomMessagePayload(message);
			if (normalized.customType === "todo-error-reminder" && typeof normalized.content === "string") {
				todoErrorReminders.push(normalized.content);
			}
			return sendCustomMessage(message, options);
		});
		({ promise: firstReminderPromise, resolve: resolveFirstReminder } = Promise.withResolvers<void>());
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "todo_reminder") {
				reminderAttempts.push(event.attempt);
				if (reminderAttempts.length === 1) resolveFirstReminder();
			}
		});

		session.setTodoPhases([
			{
				name: "Exercise",
				tasks: [
					{ content: "Install from GitHub releases path", status: "pending" },
					{ content: "Run real-world usage scenarios", status: "pending" },
				],
			},
			{ name: "Release prep", tasks: [{ content: "Smoke test release readiness", status: "pending" }] },
		]);
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	const FAILURE = 'Validation failed for tool "todo":\n  - op: op must be operation to apply (was missing)';

	// The headline a skipped call carries. Fixed per source, which is the whole
	// problem: two unrelated interrupts produce byte-identical text.
	const SKIPPED =
		"Skipped due to queued user message. Do not count this skipped result as completed work or verification. After the queued message is handled on the next step, retry the skipped tool if it is still needed.";
	const SKIPPED_DETAILS = { __skipped: true, source: "user", entered: false };
	const NEVER_DISPATCHED_DETAILS = { __synthetic: true, source: "assistant_stop_skipped", executed: false };

	it("says nothing about the payload when an interrupt skipped the todo call", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		emitTodoResult(SKIPPED, undefined, SKIPPED_DETAILS);
		emitTodoResult(SKIPPED, undefined, SKIPPED_DETAILS);
		emitTextOnlyStop();
		await session.waitForIdle();

		// The board is stale because the write never landed, not because it was
		// refused. Telling the model to fix a payload that was never read sends it
		// after a problem that does not exist, and telling it todo is unusable
		// retires the tool over an event that never happened.
		expect(todoErrorReminderTexts()).toEqual([]);
	});

	it("says nothing about the payload when the batch never dispatched the todo call", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		emitTodoResult(
			"Tool call was not executed because the assistant ended its turn.",
			undefined,
			NEVER_DISPATCHED_DETAILS,
		);
		emitTodoResult(
			"Tool call was not executed because the assistant ended its turn.",
			undefined,
			NEVER_DISPATCHED_DETAILS,
		);
		emitTextOnlyStop();
		await session.waitForIdle();

		expect(todoErrorReminderTexts()).toEqual([]);
	});

	it("remembers a real failure across a skip, so the repeat is still caught", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		emitTodoResult(FAILURE);
		// A skip is neither a landed write nor a refusal, so it must not clear the
		// memory of the failure either. Clearing it would let the same broken
		// payload be ordered forever, one interrupt apart.
		emitTodoResult(SKIPPED, undefined, SKIPPED_DETAILS);
		emitTodoResult(FAILURE);
		emitTextOnlyStop();
		await session.waitForIdle();

		const [first, second] = todoErrorReminderTexts();
		expect(todoErrorReminderTexts()).toHaveLength(2);
		expect(first).toContain("Fix the todo payload and call todo again before continuing.");
		expect(second).toContain("cannot succeed");
	});

	it("stops ordering a retry once the same todo failure repeats", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		emitTodoResult(FAILURE);
		emitTodoResult(FAILURE);
		emitTextOnlyStop();
		await session.waitForIdle();

		const [first, second] = todoErrorReminderTexts();
		expect(first).toContain("Fix the todo payload and call todo again before continuing.");
		// The second must not repeat an instruction the first already proved
		// impossible to satisfy.
		expect(second).not.toContain("call todo again before continuing");
		expect(second).toContain("cannot succeed");
		expect(second).toContain("unusable");
	});

	it("keeps asking for a fix while the failure is a different one", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		emitTodoResult(FAILURE);
		emitTodoResult('Validation failed for tool "todo":\n  - task: no task matches "Ship it"');
		emitTextOnlyStop();
		await session.waitForIdle();

		const texts = todoErrorReminderTexts();
		expect(texts).toHaveLength(2);
		for (const text of texts) expect(text).toContain("Fix the todo payload and call todo again before continuing.");
	});

	it("says the board may be stale rather than asserting a count after a failed write", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		emitTodoResult(FAILURE);
		emitTextOnlyStop();
		await session.waitForIdle();

		// Three items are recorded pending, but the write that would have closed
		// them failed, so the session cannot claim they are outstanding.
		expect(reminderAttempts).toEqual([]);
		expect(continuationReminderTexts()).toEqual([]);
		expect(todoErrorReminderTexts()[0]).toContain("the recorded board may be stale");
	});

	it("reminds again once a later todo write lands and clears the failure", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		emitTodoResult(FAILURE);
		emitTextOnlyStop();
		await session.waitForIdle();
		expect(reminderAttempts).toEqual([]);

		emitTodoResult(undefined, [{ name: "Exercise", tasks: [{ content: "Install", status: "pending" }] }]);
		emitTextOnlyStop();
		await withTimeout(firstReminderPromise, 1000, "todo_reminder never fired after a successful write");

		expect(reminderAttempts).toEqual([1]);
	});

	it("echoes the full list once per context window and short-forms the rest", async () => {
		let continueCount = 0;
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			continueCount += 1;
			// A changed board is what earns the next reminder; without it the
			// unchanged-fingerprint latch keeps the session silent. The board keeps
			// all three items throughout, so "Smoke test release readiness" being
			// absent from a later reminder is evidence of the short form rather
			// than of the task having left the board.
			const releasePrep = {
				name: "Release prep",
				tasks: [{ content: "Smoke test release readiness", status: "pending" as const }],
			};
			if (continueCount === 1) {
				emitTodoResult(undefined, [
					{
						name: "Exercise",
						tasks: [
							{ content: "Install from GitHub releases path", status: "in_progress" },
							{ content: "Run real-world usage scenarios", status: "pending" },
						],
					},
					releasePrep,
				]);
			}
			if (continueCount === 2) {
				emitTodoResult(undefined, [
					{
						name: "Exercise",
						tasks: [
							{ content: "Install from GitHub releases path", status: "pending" },
							{ content: "Run real-world usage scenarios", status: "in_progress" },
						],
					},
					releasePrep,
				]);
			}
			if (continueCount <= 2) emitTextOnlyStop();
		});

		emitTextOnlyStop();
		await withTimeout(firstReminderPromise, 1000, "todo_reminder never fired");
		await session.waitForIdle();

		const [first, second, third] = continuationReminderTexts();
		expect(reminderAttempts).toEqual([1, 2, 3]);

		// First: every open item, grouped by phase.
		expect(first).toContain("Install from GitHub releases path");
		expect(first).toContain("Run real-world usage scenarios");
		expect(first).toContain("Smoke test release readiness");
		expect(first).toContain("Exercise");
		expect(first).toContain("Release prep");

		// Second and third: the single active item only. The still-open item from
		// the other phase is the tell, so it is asserted before the marker.
		for (const later of [second, third]) {
			expect(later).not.toContain("Smoke test release readiness");
			expect(later).toContain("Active/next: ");
			expect(later.length).toBeLessThan(first.length - 40);
		}
	});

	it("spends a fresh echo after a compaction boundary", async () => {
		let continueCount = 0;
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			continueCount += 1;
			if (continueCount === 1) {
				// The compaction entry is the boundary: everything echoed before it
				// has left the model's window, so the next reminder may echo again.
				sessionManager.appendCompaction("summary", undefined, sessionManager.getBranch()[0]?.id ?? "root", 1000);
				emitTodoResult(undefined, [
					{
						name: "Exercise",
						tasks: [
							{ content: "Install from GitHub releases path", status: "in_progress" },
							{ content: "Run real-world usage scenarios", status: "pending" },
						],
					},
				]);
				emitTextOnlyStop();
			}
		});

		emitTextOnlyStop();
		await withTimeout(firstReminderPromise, 1000, "todo_reminder never fired");
		await session.waitForIdle();

		const [first, second] = continuationReminderTexts();
		expect(reminderAttempts).toEqual([1, 2]);
		expect(second).not.toContain("Active/next: ");
		expect(second).toContain("Install from GitHub releases path");
		expect(second).toContain("Run real-world usage scenarios");
		// Within one window the second would have been the short form; the
		// compaction reset is the only reason it is a list again.
		expect(second.length).toBeGreaterThan(first.length - 200);
	});

	/**
	 * Locks out: keying the per-window echo latch on every PERSISTED entry
	 * instead of the active branch. A rewind leaves the abandoned path's
	 * compaction entry in the file while the model's context is rebuilt without
	 * it, so the file-wide read reports a boundary that is no longer in the
	 * window, the latch matches it forever, and the operator never sees the full
	 * list again for the rest of the session.
	 */
	it("re-echoes after a rewind drops the compaction entry off the active branch", async () => {
		let continueCount = 0;
		const rootId = sessionManager.getBranch()[0]?.id ?? null;
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			continueCount += 1;
			if (continueCount === 1) {
				sessionManager.appendCompaction("summary", undefined, rootId ?? "root", 1000);
			}
			if (continueCount === 2) {
				// Rewind past the compaction: the entry survives in the file, the
				// branch the model sees does not carry it.
				sessionManager.branchWithSummary(rootId, "rewound past the compaction");
				expect(sessionManager.getBranch().some(entry => entry.type === "compaction")).toBe(false);
				expect(sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(true);
			}
			if (continueCount > 2) return;
			// A changed board is what earns the next reminder.
			emitTodoResult(undefined, [
				{
					name: "Exercise",
					tasks: [
						{
							content: "Install from GitHub releases path",
							status: continueCount === 1 ? "in_progress" : "pending",
						},
						{
							content: "Run real-world usage scenarios",
							status: continueCount === 1 ? "pending" : "in_progress",
						},
					],
				},
			]);
			emitTextOnlyStop();
		});

		emitTextOnlyStop();
		await withTimeout(firstReminderPromise, 1000, "todo_reminder never fired");
		await session.waitForIdle();

		// The rewind abandoned the branch carrying the first two reminders, so the
		// surviving branch holds exactly the one written after it.
		const afterRewind = continuationReminderTexts();
		expect(reminderAttempts).toEqual([1, 2, 3]);
		expect(afterRewind).toHaveLength(1);
		const third = afterRewind[0];
		// A list again, not the one-line short form.
		expect(third).not.toContain("Active/next: ");
		expect(third).toContain("Install from GitHub releases path");
		expect(third).toContain("Run real-world usage scenarios");
	});

	/**
	 * The suppression above is correct and stays, but it describes ONE unlanded
	 * write against ONE board. `#lastTodoFailureText` was cleared only by a later
	 * successful todo call, and the repeated-failure instruction tells the model
	 * to stop calling todo, so a single failure silenced every continuation
	 * reminder for the rest of the process, across sessions.
	 */
	describe("the failed-write latch does not outlive the board it describes", () => {
		const LIVE_BOARD: TodoPhase[] = [
			{ name: "Exercise", tasks: [{ content: "Install from GitHub releases path", status: "pending" }] },
		];

		/** Fail a todo write, then confirm the stop-time reminder stays silent. */
		async function latchTheFailure(): Promise<void> {
			vi.spyOn(session.agent, "continue").mockResolvedValue();
			emitTodoResult(FAILURE);
			emitTextOnlyStop();
			await session.waitForIdle();
			expect(reminderAttempts).toEqual([]);
		}

		it("clears on a new session, so /new and /clear restore the reminder", async () => {
			await latchTheFailure();

			expect(await session.newSession()).toBe(true);
			session.setTodoPhases(LIVE_BOARD);
			emitTextOnlyStop();
			await withTimeout(firstReminderPromise, 1000, "todo_reminder never fired after a new session");

			expect(reminderAttempts).toEqual([1]);
			expect(continuationReminderTexts()[0]).toContain("Install from GitHub releases path");
		});

		it("clears on a resume", async () => {
			await sessionManager.ensureOnDisk();
			const originalSessionFile = sessionManager.getSessionFile();
			if (!originalSessionFile) throw new Error("Expected the session to be on disk");
			await latchTheFailure();

			expect(await session.switchSession(originalSessionFile)).toBe(true);
			session.setTodoPhases(LIVE_BOARD);
			emitTextOnlyStop();
			await withTimeout(firstReminderPromise, 1000, "todo_reminder never fired after a resume");

			expect(reminderAttempts).toEqual([1]);
		});

		it("still refuses to assert a count while the failed write is the latest word", async () => {
			// The negative control for both tests above: clearing at a boundary must
			// not become clearing on any stop. The logged "You stopped with 8
			// incomplete todo item(s)" against a board that was never written stays
			// impossible.
			await latchTheFailure();
			emitTextOnlyStop();
			await session.waitForIdle();

			expect(reminderAttempts).toEqual([]);
			expect(continuationReminderTexts()).toEqual([]);
		});
	});
});
