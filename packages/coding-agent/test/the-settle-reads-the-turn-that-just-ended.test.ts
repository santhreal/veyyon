import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Agent } from "@veyyon/agent-core";
import type { AssistantMessage, ToolCall } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

/**
 * WHY: an `agent_end` settle read the PREVIOUS assistant message, so a turn
 * that really stopped was treated as if it still carried tool calls and every
 * stop-time pass was skipped.
 *
 * `#processAgentEvent` recorded `#lastAssistantMessage` only after
 * `await messageEndPersistence.persist(...)`. agent-core dispatches `agent_end`
 * synchronously after the `message_end` that precedes it, so the settle ran
 * first and still saw the tool-use assistant from the previous round. The
 * stop-time todo reconciliation reads `msg.content.some(c => c.type ===
 * "toolCall")` and returns early, which is why the second and third reminders
 * of a self-continuation chain never fired.
 *
 * CLASS CLOSED: state that a settle reads out of a `message_end` must be
 * recorded in the synchronous prologue of `#processAgentEvent`, before any
 * await, for EVERY burst shape the agent loop produces — not only for the
 * one-message burst the original suite happened to exercise. The sweep below
 * derives the burst shapes rather than pinning the reported one, so a handler
 * that parks the assignment behind a new await fails here at every arm.
 *
 * NOT CAUGHT: state a settle reads that is recorded somewhere other than
 * `message_end` (a tool-execution hook, a compaction pass), and ordering
 * between two settles of DIFFERENT prompts. Both are separate classes.
 */
describe("the settle reads the turn that just ended", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let reminderAttempts: number[];

	function assistantStop(): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "stopping here" }],
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

	function assistantToolUse(toolCall: ToolCall): AssistantMessage {
		return {
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
	}

	/** One completed `read` round: the assistant's tool call and its result. */
	function emitToolRound(index: number): void {
		const toolCallId = `call_read_${index}`;
		const toolCall: ToolCall = { type: "toolCall", id: toolCallId, name: "read", arguments: {} };
		session.agent.emitExternalEvent({ type: "message_end", message: assistantToolUse(toolCall) });
		session.agent.emitExternalEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId,
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				details: {},
				timestamp: Date.now(),
			},
		});
	}

	/** The text-only stop that ends the turn, plus the settle it triggers. */
	function emitStop(): void {
		const msg = assistantStop();
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
	}

	/** A settle whose last assistant message still carries a tool call. */
	function emitToolUseSettle(index: number): void {
		const toolCall: ToolCall = { type: "toolCall", id: `call_read_${index}`, name: "read", arguments: {} };
		const msg = assistantToolUse(toolCall);
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
	}

	async function settle(): Promise<void> {
		await session.waitForIdle();
		// The reminder is emitted from an async settle chain; give the queued
		// microtasks and the persistence tail a bounded window to drain so a
		// silent arm is silence rather than an unfinished arm.
		await delay(50);
		await session.waitForIdle();
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-settle-reads-turn-");
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
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "todo_reminder") reminderAttempts.push(event.attempt);
		});

		session.setTodoPhases([
			{ name: "Exercise", tasks: [{ content: "Install from GitHub releases path", status: "pending" }] },
		]);
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
	});

	// Derived rather than pinned: the reported failure was the two-round burst,
	// and every other burst length broke the same way. A handler that records the
	// assistant message behind an await fails at every arm from 1 upward.
	const BURST_LENGTHS = [0, 1, 2, 3, 5];

	for (const rounds of BURST_LENGTHS) {
		it(`reconciles todos after ${rounds} tool round(s) dispatched in one tick`, async () => {
			for (let i = 0; i < rounds; i++) emitToolRound(i);
			emitStop();
			await settle();

			expect(reminderAttempts).toEqual([1]);
		});

		it(`reconciles todos after ${rounds} tool round(s) dispatched across ticks`, async () => {
			for (let i = 0; i < rounds; i++) {
				emitToolRound(i);
				await delay(0);
			}
			emitStop();
			await settle();

			expect(reminderAttempts).toEqual([1]);
		});
	}

	// The negative control. Without it every arm above passes on a handler that
	// simply never reads the tool-call check — the reminder would fire for a turn
	// that is still mid-tool-use, which is the defect this guard exists to
	// prevent (a follow-up piled onto an in-flight turn).
	it("stays silent when the turn that ended still carried a tool call", async () => {
		emitToolRound(0);
		emitToolUseSettle(1);
		await settle();

		expect(reminderAttempts).toEqual([]);
	});

	// A tool result lands after the assistant's stop in the same burst. The
	// tracker keys on the assistant role, so the trailing non-assistant message
	// must not displace the message that ended the turn.
	it("keeps the stopping assistant when a tool result trails it in the same tick", async () => {
		const msg = assistantStop();
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		session.agent.emitExternalEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "call_read_late",
				toolName: "read",
				content: [{ type: "text", text: "late" }],
				isError: false,
				details: {},
				timestamp: Date.now(),
			},
		});
		session.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
		await settle();

		expect(reminderAttempts).toEqual([1]);
	});

	// Termination and bound: two settles in a row must each resolve, and the
	// second must be suppressed by the unchanged-board latch rather than hanging
	// or escalating. A test that can only observe a wrong attempt number cannot
	// see a settle chain that never ends.
	it("settles twice on an unchanged board without a second reminder", async () => {
		emitToolRound(0);
		emitStop();
		await settle();
		emitStop();
		await settle();

		expect(reminderAttempts).toEqual([1]);
	});
});
