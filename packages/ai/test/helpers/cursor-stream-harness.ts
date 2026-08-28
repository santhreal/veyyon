/**
 * One harness for driving Cursor's streaming state machine from a test.
 *
 * Every suite that replays a `cursor-agent` turn needs the same four things: an
 * `AssistantMessage` shaped like the one `streamCursor` fills, a `BlockState`
 * whose three block pointers are real, an event recorder around the stream, and
 * builders for the wire updates. Duplicating them per file is how two suites end
 * up replaying two different wires.
 */
import {
	type BlockState,
	createCursorUsageAccount,
	type InteractionUpdateView,
	processInteractionUpdate,
	type ToolCallState,
} from "@veyyon/ai/providers/cursor";
import type { AssistantMessage, AssistantMessageEvent, Model, ToolCall } from "@veyyon/ai/types";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";

/** Cursor's own id shape: the interaction call id and the model's function-call id, joined. */
export function callId(index: number): string {
	return `call-3059677f-b703-4b8a-8737-4493b21f4a19-${index}\nfc_eabb0594-4ec2-9515-848e-30f9e1054dcd_${index}`;
}

export function cursorAssistantMessage(): AssistantMessage {
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
		stopReason: "stop",
		timestamp: 0,
	};
}

export function newBlockState(output: AssistantMessage): BlockState {
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

/** `Record<string, Uint8Array>` is what the decoded `McpArgs.args` map holds. */
export function encodeArgs(args: Record<string, unknown>): Record<string, Uint8Array> {
	const encoded: Record<string, Uint8Array> = {};
	const encoder = new TextEncoder();
	for (const [key, value] of Object.entries(args)) {
		encoded[key] = encoder.encode(typeof value === "string" ? value : JSON.stringify(value));
	}
	return encoded;
}

export function started(id: string, name: string, args: Record<string, unknown>): InteractionUpdateView {
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

/** `toolCallStarted` for a call whose arguments Cursor has not decided yet. */
export function startedWithoutArgs(id: string, name: string): InteractionUpdateView {
	return {
		message: {
			case: "toolCallStarted",
			value: {
				callId: id,
				toolCall: {
					tool: {
						case: "mcpToolCall",
						value: { args: { toolCallId: id, name, toolName: name, args: {} } },
					},
				},
			},
		},
	};
}

/** `args_text_delta` is a cumulative snapshot of the args JSON, not a fragment. */
export function partial(id: string, snapshot: string): InteractionUpdateView {
	return { message: { case: "partialToolCall", value: { callId: id, argsTextDelta: snapshot } } };
}

export function completed(id: string, name: string, args: Record<string, unknown>): InteractionUpdateView {
	return {
		message: {
			case: "toolCallCompleted",
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

/** Completion with no argument map, the shape a purely streamed call ends with. */
export function completedBare(id: string): InteractionUpdateView {
	return { message: { case: "toolCallCompleted", value: { callId: id } } };
}

export interface Turn {
	output: AssistantMessage;
	state: BlockState;
	stream: AssistantMessageEventStream;
	events: AssistantMessageEvent[];
	send: (update: InteractionUpdateView) => void;
	calls: () => ToolCall[];
	call: (id: string) => ToolCall | undefined;
	endEvents: () => Array<{ id: string; args: unknown }>;
}

export function newTurn(): Turn {
	const output = cursorAssistantMessage();
	const stream = new AssistantMessageEventStream();
	const state = newBlockState(output);
	const events: AssistantMessageEvent[] = [];
	const push = stream.push.bind(stream);
	stream.push = (event: AssistantMessageEvent) => {
		events.push(event);
		return push(event);
	};
	const calls = () => output.content.filter((block): block is ToolCall => block.type === "toolCall");
	return {
		output,
		state,
		stream,
		events,
		send: update => processInteractionUpdate(update, output, stream, state),
		calls,
		call: id => calls().find(block => block.id === id),
		endEvents: () =>
			events
				.filter(event => event.type === "toolcall_end")
				.map(event => ({
					id: event.type === "toolcall_end" ? event.toolCall.id : "",
					args: event.type === "toolcall_end" ? event.toolCall.arguments : undefined,
				})),
	};
}
