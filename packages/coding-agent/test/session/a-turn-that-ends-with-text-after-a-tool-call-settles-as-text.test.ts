/**
 * WHY. The agent emits `message_end` and `agent_end` from one synchronous
 * `#emit`, and the session's `message_end` handler awaits persistence before it
 * records which assistant message the turn ended with. `agent_end` reads that
 * record to route every stop-time pass, so a turn that called a tool and then
 * stopped with text was routed as a tool-call turn: the settle took the
 * `hasToolCalls` exit and skipped the rewind, plan-mode, todo, verification and
 * code-review passes for that stop.
 *
 * The class this closes is the ordering, not the todo reminder that revealed it:
 * whatever the settle decides, it decides from the message the turn actually
 * ended with. The reminder is used here only because it is the cheapest
 * stop-time pass to observe from outside the session.
 *
 * What it does not catch: a pass that reads the transcript instead of the
 * settle's message, and any reordering inside the agent's own emitter, which is
 * upstream of this seam.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { AssistantMessage, ToolCall } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir, withTimeout } from "@veyyon/utils";

const USAGE = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("a turn that ends with text after a tool call settles as text", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let reminders: number[];
	let firstReminder: Promise<void>;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@veyyon-settle-message-order-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected the bundled anthropic model to exist");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": true,
				"todo.reminders.max": 3,
			}),
			modelRegistry: new ModelRegistry(authStorage),
		});

		reminders = [];
		const { promise, resolve } = Promise.withResolvers<void>();
		firstReminder = promise;
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type !== "todo_reminder") return;
			reminders.push(event.attempt);
			resolve();
		});
		session.setTodoPhases([{ name: "Exercise", tasks: [{ content: "Run the scenario", status: "pending" }] }]);
	});

	afterEach(() => {
		tempDir.removeSync();
	});

	function emitToolCall(): void {
		const toolCallId = "call_todo_settle_order";
		const toolCall: ToolCall = { type: "toolCall", id: toolCallId, name: "todo", arguments: {} };
		session.agent.emitExternalEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [toolCall],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "toolUse",
				usage: USAGE,
				timestamp: Date.now(),
			},
		});
		session.agent.emitExternalEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId,
				toolName: "todo",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				details: { phases: [{ name: "Exercise", tasks: [{ content: "Run the scenario", status: "pending" }] }] },
				timestamp: Date.now(),
			},
		});
	}

	function emitTextStop(): void {
		const msg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "done for now" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: USAGE,
			timestamp: Date.now(),
		};
		// One synchronous burst, the way the agent's own emitter delivers them: the
		// stop-time passes must see this message, not the tool call before it.
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
	}

	it("runs the stop-time passes on the text stop, not on the tool call before it", async () => {
		emitToolCall();
		emitTextStop();

		await withTimeout(firstReminder, 1000, "the settle skipped its stop-time passes");
		await session.waitForIdle();

		expect(reminders).toEqual([1]);
	});

	it("still skips them when the turn really does end mid-tool-use", async () => {
		// The negative control: without it, a fix that ran the passes unconditionally
		// would pass the test above while breaking the contract it protects — a run
		// that stops mid-tool-use must not have a reminder piled onto it.
		emitToolCall();
		const toolUseStop: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_second", name: "todo", arguments: {} }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: USAGE,
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: toolUseStop });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [toolUseStop] });

		await session.waitForIdle();

		expect(reminders).toEqual([]);
	});
});
