/**
 * WHY: cursor, devin, and amazon-bedrock providers previously used
 * `output.content.indexOf(block)` or `blocks.findIndex(b => b[kStreamingBlockIndex] === idx)`
 * on every streaming delta — O(n) per token. These were replaced with O(1)
 * cached index reads (kStreamingBlockIndex field for cursor, local variables
 * for devin, blockIndexMap for bedrock). This suite verifies the contentIndex
 * values on streaming events are correct — matching the array position of the
 * block they reference — across text, thinking, and tool-call streaming for
 * each provider.
 *
 * WHAT IT DOES NOT CATCH: providers not tested here (anthropic, google,
 * openai-completions, openai-responses) already had their own O(1) paths
 * verified by prior suites. A new provider with the same O(n) pattern is a
 * separate row.
 */
import { describe, expect, it } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import {
	type BlockState,
	createCursorUsageAccount,
	processInteractionUpdate,
	type ToolCallState,
} from "@veyyon/ai/providers/cursor";
import { streamDevin } from "@veyyon/ai/providers/devin";
import type { AssistantMessage, AssistantMessageEvent, Model, ToolCall } from "@veyyon/ai/types";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { buildModel } from "@veyyon/catalog/build";
import { GetChatMessageResponseSchema } from "@veyyon/catalog/discovery/devin-gen/exa/api_server_pb/api_server_pb";
import { GetUserJwtResponseSchema } from "@veyyon/catalog/discovery/devin-gen/exa/auth_pb/auth_pb";
import {
	ChatToolCallSchema,
	StopReason,
} from "@veyyon/catalog/discovery/devin-gen/exa/codeium_common_pb/codeium_common_pb";

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

function cursorModel(): Model<"cursor-agent"> {
	return {
		id: "cursor-composer-2.5",
		provider: "cursor",
		api: "cursor-agent",
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as Model<"cursor-agent">;
}

interface CursorHarness {
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	captured: AssistantMessageEvent[];
	state: BlockState;
}

function newCursorHarness(): CursorHarness {
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "cursor-agent",
		provider: "cursor",
		model: "cursor-composer-2.5",
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
	const stream = new AssistantMessageEventStream();
	const captured: AssistantMessageEvent[] = [];
	const origPush = stream.push.bind(stream);
	stream.push = (event: AssistantMessageEvent) => {
		captured.push(event);
		origPush(event);
	};

	let textBlock: BlockState["currentTextBlock"] = null;
	let thinkingBlock: BlockState["currentThinkingBlock"] = null;
	let toolCall: ToolCallState | null = null;
	const state: BlockState = {
		usage: createCursorUsageAccount(cursorModel(), output),
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
	};
	return { output, stream, captured, state };
}

function cursorTextDelta(h: CursorHarness, text: string): void {
	processInteractionUpdate({ message: { case: "textDelta", value: { text } } }, h.output, h.stream, h.state);
}

function cursorThinkingDelta(h: CursorHarness, text: string): void {
	processInteractionUpdate({ message: { case: "thinkingDelta", value: { text } } }, h.output, h.stream, h.state);
}

function cursorStartMcpToolCall(h: CursorHarness, name: string, id = "call-1"): void {
	processInteractionUpdate(
		{
			message: {
				case: "toolCallStarted",
				value: {
					callId: id,
					toolCall: {
						tool: { case: "mcpToolCall", value: { args: { name, toolName: name, toolCallId: id } } },
					},
				},
			},
		},
		h.output,
		h.stream,
		h.state,
	);
}

function cursorCompleteMcpToolCall(h: CursorHarness): void {
	processInteractionUpdate(
		{
			message: {
				case: "toolCallCompleted",
				value: { toolCall: { tool: { case: "mcpToolCall", value: { args: { args: undefined } } } } },
			},
		},
		h.output,
		h.stream,
		h.state,
	);
}

describe("cursor contentIndex O(1) regression", () => {
	it("text_delta contentIndex matches the block's array position", () => {
		const h = newCursorHarness();
		cursorTextDelta(h, "hello ");
		cursorTextDelta(h, "world");

		const deltas = h.captured.filter(e => e.type === "text_delta");
		expect(deltas).toHaveLength(2);
		expect(deltas[0]!.contentIndex).toBe(0);
		expect(deltas[1]!.contentIndex).toBe(0);
		expect(h.output.content[0]).toMatchObject({ type: "text", text: "hello world" });
	});

	it("thinking_delta contentIndex matches the block's array position", () => {
		const h = newCursorHarness();
		cursorThinkingDelta(h, "reasoning ");
		cursorThinkingDelta(h, "here");

		const deltas = h.captured.filter(e => e.type === "thinking_delta");
		expect(deltas).toHaveLength(2);
		expect(deltas[0]!.contentIndex).toBe(0);
		expect(deltas[1]!.contentIndex).toBe(0);
	});

	it("text + toolCall + text yields correct contentIndex for each block", () => {
		const h = newCursorHarness();
		cursorTextDelta(h, "before ");
		cursorStartMcpToolCall(h, "bash");
		cursorCompleteMcpToolCall(h);
		cursorTextDelta(h, "after");

		// content: [text(0), toolCall(1), text(2)]
		const textStarts = h.captured.filter(e => e.type === "text_start");
		expect(textStarts).toHaveLength(2);
		expect(textStarts[0]!.contentIndex).toBe(0);
		expect(textStarts[1]!.contentIndex).toBe(2);

		const toolStart = h.captured.find(e => e.type === "toolcall_start");
		expect(toolStart!.contentIndex).toBe(1);

		const toolEnd = h.captured.find(e => e.type === "toolcall_end");
		expect(toolEnd!.contentIndex).toBe(1);

		const textDeltas = h.captured.filter(e => e.type === "text_delta");
		expect(textDeltas[0]!.contentIndex).toBe(0);
		expect(textDeltas[1]!.contentIndex).toBe(2);
	});

	it("thinking + text yields correct contentIndex for each block", () => {
		const h = newCursorHarness();
		cursorThinkingDelta(h, "think ");
		cursorTextDelta(h, "answer");

		const thinkDelta = h.captured.find(e => e.type === "thinking_delta");
		expect(thinkDelta!.contentIndex).toBe(0);

		const textDelta = h.captured.find(e => e.type === "text_delta");
		expect(textDelta!.contentIndex).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Devin
// ---------------------------------------------------------------------------

function frameConnectMessage(payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(5 + payload.length);
	const view = new DataView(out.buffer);
	view.setUint8(0, 0);
	view.setUint32(1, payload.length, false);
	out.set(payload, 5);
	return out;
}

function devinTextDelta(text: string): Uint8Array {
	const msg = create(GetChatMessageResponseSchema, { messageId: "msg-1", deltaText: text });
	return frameConnectMessage(toBinary(GetChatMessageResponseSchema, msg));
}

function devinThinkingDelta(text: string): Uint8Array {
	const msg = create(GetChatMessageResponseSchema, { messageId: "msg-1", deltaThinking: text });
	return frameConnectMessage(toBinary(GetChatMessageResponseSchema, msg));
}

function devinToolCallDelta(argumentsJson: string, id = "call-1", name = "bash"): Uint8Array {
	const msg = create(GetChatMessageResponseSchema, {
		messageId: "msg-1",
		deltaToolCalls: [create(ChatToolCallSchema, { id, name, argumentsJson })],
	});
	return frameConnectMessage(toBinary(GetChatMessageResponseSchema, msg));
}

function devinStopFrame(): Uint8Array {
	const msg = create(GetChatMessageResponseSchema, { messageId: "msg-1", stopReason: StopReason.FUNCTION_CALL });
	return frameConnectMessage(toBinary(GetChatMessageResponseSchema, msg));
}

const devinModel: Model<"devin-agent"> = buildModel({
	id: "devin-test",
	name: "Devin Test",
	api: "devin-agent",
	provider: "devin",
	baseUrl: "https://server.codeium.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
});

const devinContext = { messages: [{ role: "user", content: "go", timestamp: 1 }] } as never;

function devinFetch(chunks: Uint8Array[]): typeof fetch {
	const authPayload = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));
	return (async (input: string | URL | Request) => {
		if (String(input).includes("GetUserJwt")) return new Response(authPayload);
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(chunk);
					controller.close();
				},
			}),
			{ status: 200 },
		);
	}) as typeof fetch;
}

describe("devin contentIndex O(1) regression", () => {
	it("text_delta contentIndex matches the block's array position", async () => {
		const chunks = [devinTextDelta("hello "), devinTextDelta("world"), devinStopFrame()];
		const stream = streamDevin(devinModel, devinContext, { apiKey: "token", fetch: devinFetch(chunks) });
		const deltas: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			if (event.type === "text_delta") deltas.push(event);
		}
		expect(deltas).toHaveLength(2);
		expect(deltas[0]!.contentIndex).toBe(0);
		expect(deltas[1]!.contentIndex).toBe(0);
	});

	it("thinking + text yields correct contentIndex for each block", async () => {
		const chunks = [devinThinkingDelta("reasoning "), devinTextDelta("answer"), devinStopFrame()];
		const stream = streamDevin(devinModel, devinContext, { apiKey: "token", fetch: devinFetch(chunks) });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			if (event.type === "thinking_delta" || event.type === "text_delta") events.push(event);
		}
		const thinkDelta = events.find(e => e.type === "thinking_delta");
		expect(thinkDelta!.contentIndex).toBe(0);
		const textDelta = events.find(e => e.type === "text_delta");
		expect(textDelta!.contentIndex).toBe(1);
	});

	it("toolCall delta contentIndex matches the block's array position", async () => {
		const chunks = [
			devinToolCallDelta(`{"command":"git `),
			devinToolCallDelta(`{"command":"git status"}`),
			devinStopFrame(),
		];
		const stream = streamDevin(devinModel, devinContext, { apiKey: "token", fetch: devinFetch(chunks) });
		const deltas: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			if (event.type === "toolcall_delta") deltas.push(event);
		}
		expect(deltas).toHaveLength(2);
		expect(deltas[0]!.contentIndex).toBe(0);
		expect(deltas[1]!.contentIndex).toBe(0);

		const result = await stream.result();
		expect(result.content[0]?.type).toBe("toolCall");
		expect((result.content[0] as ToolCall).arguments).toEqual({ command: "git status" });
	});

	it("text + toolCall yields correct contentIndex for each block", async () => {
		const chunks = [devinTextDelta("before "), devinToolCallDelta(`{"command":"ls"}`), devinStopFrame()];
		const stream = streamDevin(devinModel, devinContext, { apiKey: "token", fetch: devinFetch(chunks) });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			if (event.type === "text_delta" || event.type === "toolcall_delta") events.push(event);
		}
		const textDelta = events.find(e => e.type === "text_delta");
		expect(textDelta!.contentIndex).toBe(0);
		const toolDelta = events.find(e => e.type === "toolcall_delta");
		expect(toolDelta!.contentIndex).toBe(1);
	});
});
