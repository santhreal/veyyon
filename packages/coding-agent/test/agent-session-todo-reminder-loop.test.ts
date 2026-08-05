import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Agent } from "@veyyon/agent-core";
import type { AssistantMessage, TextContent, ToolCall } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir, withTimeout } from "@veyyon/utils";

/**
 * Regression coverage for issue #2590: `#checkTodoCompletion` used to schedule
 * `agent.continue()` after appending its `<system-reminder>`, so any text-only
 * acknowledgement from the agent ("paused at your instruction") triggered another
 * `agent_end`, which incremented the counter and fired the next reminder — no
 * user input required. Within a single user pause that loop runs 1/3 → 2/3 → 3/3.
 *
 * The contract these tests defend: a reminder MUST NOT escalate inside a
 * self-continuation chain unless the agent has produced a tool-level result
 * (e.g. called `todo` or `edit`) between the prior reminder and the next stop.
 */
describe("AgentSession todo reminder self-continuation suppression", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let reminderAttempts: number[];
	let firstReminderPromise: Promise<void>;
	let resolveFirstReminder: () => void;

	function textOnlyAssistantMessage(text = "paused at your instruction"): AssistantMessage {
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

	function emitTextOnlyStop(text?: string): void {
		const msg = textOnlyAssistantMessage(text);
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
	}

	function emitToolResult(toolName: string, details: Record<string, unknown> = {}): void {
		const toolCallId = `call_${toolName}_${Date.now()}_${Math.random()}`;
		const toolCall: ToolCall = { type: "toolCall", id: toolCallId, name: toolName, arguments: {} };
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
		const content: TextContent[] = [{ type: "text", text: "ok" }];
		session.agent.emitExternalEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId,
				toolName,
				content,
				isError: false,
				details,
				timestamp: Date.now(),
			},
		});
	}

	function todoReminderTranscriptEntry() {
		return sessionManager.getBranch().find(entry => {
			if (entry.type !== "message" || entry.message.role !== "developer") return false;
			const { content } = entry.message;
			if (!Array.isArray(content)) return false;
			return content.some(
				(item): item is TextContent =>
					item.type === "text" && item.text.includes("Continue working now. 2 todo item(s) remain."),
			);
		});
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-todo-reminder-loop-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": true,
			}),
			modelRegistry,
		});

		reminderAttempts = [];
		({ promise: firstReminderPromise, resolve: resolveFirstReminder } = Promise.withResolvers<void>());
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "todo_reminder") {
				reminderAttempts.push(event.attempt);
				if (reminderAttempts.length === 1) resolveFirstReminder();
			}
		});

		session.setTodoPhases([
			{
				name: "Pending review",
				tasks: [
					{ content: "Slice 81", status: "pending" },
					{ content: "Slice 82", status: "pending" },
				],
			},
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

	it("baseline: a single text-only stop fires reminder 1/3 and records it in the transcript", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		emitTextOnlyStop();
		await withTimeout(firstReminderPromise, 1000, "todo_reminder never fired");
		expect(reminderAttempts).toEqual([1]);

		const reminderEntry = todoReminderTranscriptEntry();
		expect(reminderEntry?.type).toBe("message");
	});

	it("does not add a todo reminder or continuation while an active goal owns continuation", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-1",
				objective: "Finish the owned task",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				turnsCompleted: 0,
				createdAt: now,
				updatedAt: now,
			},
		});

		emitTextOnlyStop();
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([]);
		expect(todoReminderTranscriptEntry()).toBeUndefined();
		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("does not remind or continue when the assistant yields with a user-facing question", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		emitTextOnlyStop("I need your feedback before continuing. Which trade-off should I optimize for?");
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([]);
		expect(todoReminderTranscriptEntry()).toBeUndefined();
		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("still reminds when the assistant answers its own prompt-shaped question", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		emitTextOnlyStop(
			"Which configuration should this use?\nUse the existing default; the remaining todo items still need work.",
		);
		await withTimeout(firstReminderPromise, 1000, "todo_reminder never fired");
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([1]);
		expect(todoReminderTranscriptEntry()).toBeDefined();
		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("still reminds and continues when ordinary prose contains answer", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		emitTextOnlyStop("Final answer: I summarized the work completed so far, but the todo items remain open.");
		await withTimeout(firstReminderPromise, 1000, "todo_reminder never fired");
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([1]);
		expect(todoReminderTranscriptEntry()).toBeDefined();
		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("still reminds and continues when TypeScript optional syntax appears in the assistant tail", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		emitTextOnlyStop("Tail note: the interface includes foo?: string, but the todo items remain open.");
		await withTimeout(firstReminderPromise, 1000, "todo_reminder never fired");
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([1]);
		expect(todoReminderTranscriptEntry()).toBeDefined();
		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("fires exactly one reminder per user pause when the agent only acknowledges", async () => {
		// Each call to continue() mirrors what the bug-reported model did: emit another
		// text-only stop ("paused at your instruction"), no tool calls in between.
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			emitTextOnlyStop();
		});

		emitTextOnlyStop();
		await withTimeout(firstReminderPromise, 1000, "todo_reminder never fired");
		await session.waitForIdle();

		// With the bug: reminderAttempts === [1, 2, 3] within a single user pause.
		// With the fix: the second `agent_end` is suppressed because no tool action ran
		// between the first reminder and the agent's text-only ack.
		expect(reminderAttempts).toEqual([1]);
	});

	/**
	 * A user asking the agent to resume must not replay the same task list when the
	 * prior continuation produced no tool result. The prompt itself is not progress.
	 */
	it("keeps the same reminder suppressed across repeated user continue prompts", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			emitTextOnlyStop();
			return undefined as never;
		});

		emitTextOnlyStop();
		await withTimeout(firstReminderPromise, 1000, "todo_reminder never fired");
		await session.waitForIdle();

		await session.prompt("why did you stop; continue working");
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([1]);
	});

	it("does not repeat an unchanged todo snapshot after unrelated tool activity", async () => {
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			emitToolResult("todo", { phases: session.getTodoPhases() });
			emitTextOnlyStop();
		});

		emitTextOnlyStop();
		await withTimeout(firstReminderPromise, 1000, "todo_reminder never fired");
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([1]);
	});

	/** A real status transition changes the fingerprint and warrants one new bounded continuation reminder. */
	it("reminds again only after the todo state changes", async () => {
		let continueCount = 0;
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			continueCount += 1;
			if (continueCount === 1) {
				emitToolResult("todo", {
					phases: [
						{
							name: "Pending review",
							tasks: [
								{ content: "Slice 81", status: "completed" },
								{ content: "Slice 82", status: "in_progress" },
							],
						},
					],
				});
			}
			emitTextOnlyStop();
		});

		emitTextOnlyStop();
		await withTimeout(firstReminderPromise, 1000, "todo_reminder never fired");
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([1, 2]);
	});

	/**
	 * Disabling reminders is itself the lifecycle boundary: the latch must reset
	 * even when no assistant stop occurs until after reminders are re-enabled.
	 */
	it("starts a fresh reminder runway after reminders are disabled and re-enabled", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		emitTextOnlyStop();
		await withTimeout(firstReminderPromise, 1000, "first todo_reminder never fired");
		await session.waitForIdle();

		session.settings.set("todo.reminders", false);
		expect(session.settings.get("todo.reminders")).toBe(false);

		const secondReminder = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "todo_reminder") secondReminder.resolve();
		});
		session.settings.set("todo.reminders", true);
		expect(session.settings.get("todo.reminders")).toBe(true);
		emitTextOnlyStop();
		await withTimeout(secondReminder.promise, 1000, "re-enabled todo_reminder never fired");

		expect(reminderAttempts).toEqual([1, 1]);
	});

	/**
	 * A slow message-end subscriber must not let the later agent-end event observe
	 * stale todo state and emit a continuation for work the todo result completed.
	 */
	it("applies todo result state before awaiting message-end subscribers", async () => {
		const messageEndGate = Promise.withResolvers<void>();
		const agentEndSeen = Promise.withResolvers<void>();
		session.subscribe(async event => {
			if (event.type === "message_end" && event.message.role === "toolResult") {
				await messageEndGate.promise;
			}
			if (event.type === "agent_end") agentEndSeen.resolve();
		});
		vi.spyOn(session.agent, "continue").mockResolvedValue();

		emitToolResult("todo", {
			phases: [
				{
					name: "Pending review",
					tasks: [
						{ content: "Slice 81", status: "completed" },
						{ content: "Slice 82", status: "completed" },
					],
				},
			],
		});
		emitTextOnlyStop();
		await withTimeout(agentEndSeen.promise, 1000, "agent_end never reached subscribers");
		await delay(0);

		expect(reminderAttempts).toEqual([]);
		expect(session.getTodoPhases()[0]?.tasks).toEqual([
			{ content: "Slice 81", status: "completed" },
			{ content: "Slice 82", status: "completed" },
		]);

		messageEndGate.resolve();
		await session.waitForIdle();
	});

	/**
	 * UI renderers may bound their preview, but extension subscribers rely on the
	 * event payload as lossless machine state for automation.
	 */
	it("emits every unfinished item to reminder subscribers beyond the preview limit", async () => {
		const tasks = Array.from({ length: 8 }, (_, index) => ({
			content: `Extension task ${index + 1}`,
			status: index === 7 ? ("in_progress" as const) : ("pending" as const),
		}));
		let emitted: Extract<AgentSessionEvent, { type: "todo_reminder" }> | undefined;
		session.subscribe(event => {
			if (event.type === "todo_reminder") emitted = event;
		});
		session.setTodoPhases([{ name: "Extension contract", tasks }]);
		vi.spyOn(session.agent, "continue").mockResolvedValue();

		emitTextOnlyStop();
		await withTimeout(firstReminderPromise, 1000, "todo_reminder never fired");

		expect(emitted?.todos).toEqual(tasks);
	});
});
