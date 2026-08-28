/**
 * WHY. A tool call is answered once. Something outside the loop can run a call
 * and write its result: Cursor's exec channel dispatches an MCP call through
 * the caller's handler INSIDE the provider stream, answers it there, and the
 * same call also arrives on the assistant stream as a `toolCall` block. The
 * provider stamps such a block `kCursorExecResolved` and the loop skips it.
 *
 * That marker is bookkeeping kept by the same code that had the defect. In a
 * recorded session a `set_cwd` call was answered by the exec channel with real
 * arguments and then executed a SECOND time by the loop, which appended
 * `Validation failed for tool "set_cwd" ... Received arguments: {}` as a second
 * result under an id that already had one — and, because a tool result restarts
 * the loop, cost the operator a whole extra model turn on one typed message.
 *
 * The defect class: the loop deciding what to run from a marker on the block
 * rather than from what the transcript says already happened. Any provider that
 * answers a call out of band, any marker that is missed, dropped by a copy, or
 * never applied, is a member. The invariant that closes it is transcript-level
 * and provider-independent: a call id that already carries a real result is not
 * runnable.
 *
 * A never-ran placeholder is not a real result. The loop writes those for calls
 * it abandoned, and a continuation must still be able to run them, so both
 * placeholder shapes are exercised here as negative controls.
 *
 * What this suite does NOT catch: it drives `agentLoop` with a scripted stream,
 * so it says nothing about which ids a real provider puts on its blocks and
 * results. If a provider answers a call under an id its block does not carry,
 * the pairing is broken before the loop sees it, and no assertion here fires.
 */
import { describe, expect, it } from "bun:test";
import { agentLoop } from "@veyyon/agent-core/agent-loop";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
} from "@veyyon/agent-core/types";
import type { AssistantMessage, Message, ToolResultMessage } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { type } from "arktype";
import { createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

const ANSWERED = "call-answered-1";
const UNANSWERED = "call-unanswered-1";

interface Recorded {
	executed: string[];
	messages: AgentMessage[];
	events: AgentEvent[];
}

/**
 * One turn whose assistant message carries `ANSWERED` (plus `UNANSWERED` when
 * asked), with `priorResult` already in the transcript. No block carries
 * `kCursorExecResolved`: the point is what the loop decides without it.
 */
async function runTurn(options: {
	priorResult?: ToolResultMessage;
	includeUnanswered?: boolean;
}): Promise<Recorded> {
	const schema = type({ command: "string" });
	const executed: string[] = [];
	const tool: AgentTool<typeof schema, { command: string }> = {
		name: "bash",
		label: "Bash",
		description: "Run shell commands",
		parameters: schema,
		async execute(id, params) {
			executed.push(id);
			return {
				content: [{ type: "text", text: `ran ${params.command}` }],
				details: { command: params.command },
			};
		},
	};

	const context: AgentContext = {
		systemPrompt: [""],
		messages: options.priorResult ? [options.priorResult] : [],
		tools: [tool],
	};
	const config: AgentLoopConfig = { model: createMockModel().model, convertToLlm: identityConverter };

	let turn = 0;
	const streamFn = () => {
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			const first = turn++ === 0;
			const content: AssistantMessage["content"] = first
				? [
						{ type: "toolCall", id: ANSWERED, name: "bash", arguments: { command: "already ran" } },
						...(options.includeUnanswered
							? [
									{
										type: "toolCall" as const,
										id: UNANSWERED,
										name: "bash",
										arguments: { command: "not yet" },
									},
								]
							: []),
					]
				: [{ type: "text", text: "done" }];
			const message: AssistantMessage = {
				role: "assistant",
				content,
				api: "cursor-agent",
				provider: "cursor",
				model: "cursor-grok-4.6-medium",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: first ? "toolUse" : "stop",
				timestamp: Date.now(),
			};
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
		});
		return stream;
	};

	const events: AgentEvent[] = [];
	const stream = agentLoop([createUserMessage("go")], context, config, undefined, streamFn);
	for await (const event of stream) events.push(event);
	const messages = await stream.result();
	return { executed, messages, events };
}

function execChannelResult(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: ANSWERED,
		toolName: "bash",
		content: [{ type: "text", text: "ran on the provider's exec channel" }],
		isError: false,
		timestamp: 1,
	};
}

function neverRanPlaceholder(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: ANSWERED,
		toolName: "bash",
		content: [{ type: "text", text: "Not executed." }],
		isError: false,
		timestamp: 1,
		details: { __synthetic: true, executed: false },
	};
}

function interruptedBeforeEntryPlaceholder(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: ANSWERED,
		toolName: "bash",
		content: [{ type: "text", text: "Interrupted before this call ran." }],
		isError: false,
		timestamp: 1,
		details: { __skipped: true, entered: false },
	};
}

function enteredThenInterruptedResult(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: ANSWERED,
		toolName: "bash",
		content: [{ type: "text", text: "Interrupted while running." }],
		isError: false,
		timestamp: 1,
		details: { __skipped: true, entered: true },
	};
}

function resultsFor(messages: AgentMessage[], toolCallId: string): ToolResultMessage[] {
	return messages.filter(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === toolCallId,
	);
}

describe("a tool call the transcript already answered", () => {
	it("is not executed again, whatever ran it", async () => {
		const { executed } = await runTurn({ priorResult: execChannelResult() });

		expect(executed).toEqual([]);
	});

	it("gains no second result under the id that already had one", async () => {
		// Two results for one `tool_use` id is the wire-level damage: it replays on
		// every later request in the session, not only on the turn that made it.
		const { messages } = await runTurn({ priorResult: execChannelResult() });

		expect(resultsFor(messages, ANSWERED)).toHaveLength(0);
	});

	it("does not cost an extra model turn", async () => {
		// The re-run appended a result, and a result restarts the loop. One typed
		// message became two model turns, which is what the operator saw.
		const withPrior = await runTurn({ priorResult: execChannelResult() });
		const assistantTurns = withPrior.messages.filter(message => message.role === "assistant");

		expect(assistantTurns).toHaveLength(1);
	});

	it("still runs the sibling call of the same batch that has no result", async () => {
		// The over-match control: refusing the answered call must not swallow the
		// batch. Dropping a call the model asked for is a quieter failure than
		// running it twice.
		const { executed } = await runTurn({ priorResult: execChannelResult(), includeUnanswered: true });

		expect(executed).toEqual([UNANSWERED]);
	});

	it("runs a call whose only result is a never-ran placeholder", async () => {
		// The loop writes this shape for a call it abandoned. Treating it as an
		// answer would strand every continuation that reissues the batch.
		const { executed } = await runTurn({ priorResult: neverRanPlaceholder() });

		expect(executed).toEqual([ANSWERED]);
	});

	it("runs a call an interrupt cut the batch short of before it started", async () => {
		const { executed } = await runTurn({ priorResult: interruptedBeforeEntryPlaceholder() });

		expect(executed).toEqual([ANSWERED]);
	});

	it("refuses a call an interrupt hit while it was running", async () => {
		// `entered: true` means side effects are real and partial, so this one is
		// an answer even though it reads like a placeholder.
		const { executed } = await runTurn({ priorResult: enteredThenInterruptedResult() });

		expect(executed).toEqual([]);
	});

	it("runs the call when the transcript holds no result for it", async () => {
		// The baseline that proves every assertion above is about the prior result
		// and not about the harness refusing to run anything.
		const { executed } = await runTurn({});

		expect(executed).toEqual([ANSWERED]);
	});
});
