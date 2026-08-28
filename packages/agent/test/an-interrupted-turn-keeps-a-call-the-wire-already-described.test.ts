/**
 * WHY. Two mechanisms in two packages have to agree about one thing, and when
 * they disagreed the operator lost a tool call and paid for a phantom re-run.
 *
 * Cursor delivers a call's whole argument map on the `toolCallStarted` frame,
 * before any argument delta. The provider seeds the block's streamed-argument
 * buffer with that map, because a call whose completion never arrives has
 * nothing else. The agent loop reads exactly that buffer: on an interrupted or
 * failed turn it keeps a call whose buffer parses to an object and deletes the
 * rest, recording them as "arguments never finished".
 *
 * While the provider left the buffer empty, an interrupted Cursor turn handed
 * the loop a fully described call with an empty buffer, so the loop deleted a
 * call the wire had finished describing and told the model no record of it was
 * left. The tool had, in one recorded session, already RUN.
 *
 * Each package tests its own half. Nothing tested the agreement, which is
 * where the defect lived: the provider suite asserts a buffer, the loop suite
 * asserts a rule about buffers, and both stayed green. This drives the real
 * provider state machine to build the message and the real loop to judge it.
 *
 * The class: a value one module writes only so another module can read it,
 * with each side pinned separately. Every member survives both suites.
 *
 * What this suite does NOT catch: it feeds the loop a message the provider
 * built, not a live socket, so a transport that never delivers the started
 * frame is outside it. It also asserts retention and arguments, not what the
 * following turn does with the retained call.
 */
import { describe, expect, it } from "bun:test";
import { agentLoop } from "@veyyon/agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "@veyyon/agent-core/types";
import type { AssistantMessage, Model, ToolCall } from "@veyyon/ai";
import {
	type BlockState,
	createCursorUsageAccount,
	type InteractionUpdateView,
	processInteractionUpdate,
	type ToolCallState,
} from "@veyyon/ai/providers/cursor";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { type } from "arktype";
import { createUserMessage } from "./helpers";

/** Cursor's own id shape: the interaction call id and the function-call id, joined. */
const CALL_ID = "call-9f2c1d70-6a4b-4f2e-8a11-0c6d5e3b7a48-0\nfc_2b1e5d90-77c3-4a6f-9d21-8e0f4c2a6b35_0";
const SIBLING_ID = "call-9f2c1d70-6a4b-4f2e-8a11-0c6d5e3b7a48-1\nfc_2b1e5d90-77c3-4a6f-9d21-8e0f4c2a6b35_1";

const CALL_ARGS = { command: "bun run check:ts", timeout: 600 } as const;

function encodeArgs(args: Record<string, unknown>): Record<string, Uint8Array> {
	const encoder = new TextEncoder();
	const encoded: Record<string, Uint8Array> = {};
	for (const [key, value] of Object.entries(args)) {
		encoded[key] = encoder.encode(typeof value === "string" ? value : JSON.stringify(value));
	}
	return encoded;
}

function startedFrame(id: string, name: string, args: Record<string, unknown>): InteractionUpdateView {
	return {
		message: {
			case: "toolCallStarted",
			value: {
				callId: id,
				toolCall: {
					tool: {
						case: "mcpToolCall",
						value: { args: { toolCallId: id, name, toolName: name, args: encodeArgs(args) } },
					},
				},
			},
		},
	};
}

function emptyCursorMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
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
		stopReason: "aborted",
		timestamp: 0,
	};
}

function blockState(output: AssistantMessage): BlockState {
	let textBlock: BlockState["currentTextBlock"] = null;
	let thinkingBlock: BlockState["currentThinkingBlock"] = null;
	let toolCall: ToolCallState | null = null;
	return {
		usage: createCursorUsageAccount(
			{
				id: "cursor-grok-4.6-medium",
				provider: "cursor",
				api: "cursor-agent",
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			} as Model<"cursor-agent">,
			output,
		),
		get currentTextBlock() {
			return textBlock;
		},
		get currentThinkingBlock() {
			return thinkingBlock;
		},
		get currentToolCall() {
			return toolCall;
		},
		firstTokenTime: undefined,
		setTextBlock: b => {
			textBlock = b;
		},
		setThinkingBlock: b => {
			thinkingBlock = b;
		},
		setToolCall: t => {
			toolCall = t;
		},
		setFirstTokenTime: () => {},
		execDispatchedToolCalls: new Set<string>(),
	};
}

/**
 * The turn an interrupt cuts short: Cursor opened the calls and delivered their
 * arguments, and nothing closed them. Built by the real provider state machine,
 * so the buffer the loop reads is the one the provider actually writes.
 */
function interruptedCursorTurn(frames: InteractionUpdateView[]): AssistantMessage {
	const output = emptyCursorMessage();
	const stream = new AssistantMessageEventStream();
	const state = blockState(output);
	for (const frame of frames) processInteractionUpdate(frame, output, stream, state);
	return output;
}

/** Runs one loop turn over a message the provider already built. */
async function judge(message: AssistantMessage): Promise<AgentMessage[]> {
	const schema = type({ "command?": "string", "timeout?": "number" });
	const tool: AgentTool<typeof schema, Record<string, never>> = {
		name: "bash",
		label: "Bash",
		description: "Run shell commands",
		parameters: schema,
		async execute() {
			// The turn aborted, so the loop must not reach a tool. A call here would
			// mean an aborted turn ran its tools, which is a different defect.
			throw new Error("an aborted turn must not execute a tool");
		},
	};
	const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
	const config: AgentLoopConfig = { model: createMockModel().model, convertToLlm: messages => messages as never };

	const streamFn = () => {
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			stream.push({ type: "error", reason: "aborted", error: message });
		});
		return stream;
	};

	const loop = agentLoop([createUserMessage("check the types")], context, config, undefined, streamFn);
	for await (const _event of loop) {
		// Drain: the assertions read the settled transcript, not the event feed.
	}
	return loop.result();
}

function assistantOf(messages: AgentMessage[]): AssistantMessage {
	const assistant = messages.find((message): message is AssistantMessage => message.role === "assistant");
	if (!assistant) throw new Error("the loop kept no assistant message");
	return assistant;
}

function callsOf(message: AssistantMessage): ToolCall[] {
	return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

describe("a Cursor call the wire described but never closed", () => {
	it("reaches the loop carrying the arguments its start frame delivered", () => {
		// The provider's half of the agreement, asserted on the real block rather
		// than on a fixture written to look like one.
		const turn = interruptedCursorTurn([startedFrame(CALL_ID, "bash", CALL_ARGS)]);

		expect(callsOf(turn)).toHaveLength(1);
		expect(callsOf(turn)[0]?.arguments).toEqual(CALL_ARGS);
	});

	it("survives the interrupted turn instead of being deleted", async () => {
		const turn = interruptedCursorTurn([startedFrame(CALL_ID, "bash", CALL_ARGS)]);

		const assistant = assistantOf(await judge(turn));

		expect(callsOf(assistant).map(call => call.id)).toEqual([CALL_ID]);
	});

	it("keeps its own arguments through the loop's rewrite", async () => {
		// Retention is worth nothing if the retained call comes back with the
		// tolerant partial parse a streaming block carries mid-flight.
		const turn = interruptedCursorTurn([startedFrame(CALL_ID, "bash", CALL_ARGS)]);

		const assistant = assistantOf(await judge(turn));

		expect(callsOf(assistant)[0]?.arguments).toEqual(CALL_ARGS);
	});

	it("is not reported to the model as a call whose arguments never finished", async () => {
		// The false statement the operator saw: a complete call described in the
		// ledger as unreconstructable, with its arguments destroyed to prove it.
		const turn = interruptedCursorTurn([startedFrame(CALL_ID, "bash", CALL_ARGS)]);

		const assistant = assistantOf(await judge(turn));

		expect(assistant.incompleteToolCalls ?? []).toEqual([]);
	});

	it("keeps both calls of an interrupted batch, each with its own arguments", async () => {
		// The pointer defect corrupted siblings, so the agreement has to hold for a
		// batch and not only for the single call that is easy to test.
		const turn = interruptedCursorTurn([
			startedFrame(CALL_ID, "bash", CALL_ARGS),
			startedFrame(SIBLING_ID, "bash", { command: "bun test", timeout: 60 }),
		]);

		const assistant = assistantOf(await judge(turn));

		expect(callsOf(assistant).map(call => ({ id: call.id, arguments: call.arguments }))).toEqual([
			{ id: CALL_ID, arguments: CALL_ARGS },
			{ id: SIBLING_ID, arguments: { command: "bun test", timeout: 60 } },
		]);
		expect(assistant.incompleteToolCalls ?? []).toEqual([]);
	});

	it("is still reported as unfinished when the wire described nothing", async () => {
		// The other side of the rule: a start frame with an empty argument map
		// leaves nothing to retain, and the ledger must name the call rather than
		// let a truly argument-less block through to a tool.
		const turn = interruptedCursorTurn([startedFrame(CALL_ID, "bash", {})]);

		const assistant = assistantOf(await judge(turn));

		expect(callsOf(assistant)).toEqual([]);
		expect(assistant.incompleteToolCalls).toEqual([{ id: CALL_ID, name: "bash" }]);
	});

	it("is still reported as unfinished when its streamed arguments were cut mid-JSON", async () => {
		// A call whose start frame carried nothing and whose deltas stopped inside
		// the JSON: the buffer does not parse, so retention must refuse it.
		const turn = interruptedCursorTurn([
			startedFrame(CALL_ID, "bash", {}),
			{ message: { case: "partialToolCall", value: { callId: CALL_ID, argsTextDelta: '{"command":"bun ru' } } },
		]);

		const assistant = assistantOf(await judge(turn));

		expect(callsOf(assistant)).toEqual([]);
		expect(assistant.incompleteToolCalls).toEqual([{ id: CALL_ID, name: "bash" }]);
	});

	it("keeps the streamed arguments when the deltas did complete the JSON", async () => {
		// Between the two: no start-frame map, but the deltas closed the object
		// before the interrupt. The call is complete and must survive.
		const turn = interruptedCursorTurn([
			startedFrame(SIBLING_ID, "bash", {}),
			{
				message: {
					case: "partialToolCall",
					value: { callId: SIBLING_ID, argsTextDelta: '{"command":"bun test"}' },
				},
			},
		]);

		const assistant = assistantOf(await judge(turn));

		expect(callsOf(assistant).map(call => call.arguments)).toEqual([{ command: "bun test" }]);
		expect(assistant.incompleteToolCalls ?? []).toEqual([]);
	});
});
