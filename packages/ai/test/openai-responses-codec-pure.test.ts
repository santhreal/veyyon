import { describe, expect, it } from "bun:test";
import {
	createInitialResponsesAssistantMessage,
	finalizePendingResponsesToolCalls,
	mapOpenAIResponsesStopReason,
	promoteResponsesToolUseStopReason,
	RESPONSES_API_TOOL_CALL_DELTA_SHAPES,
	RESPONSES_PROVIDER_TOOL_CALL_DELTA_SHAPES,
	resolveResponsesToolCallDeltaShape,
} from "../src/providers/openai-responses-codec";
import type { AssistantMessage, ToolCall } from "../src/types";
import { kStreamingPartialJson } from "../src/utils/block-symbols";

describe("resolveResponsesToolCallDeltaShape", () => {
	it("returns shape for known provider string", () => {
		const provider = Object.keys(RESPONSES_PROVIDER_TOOL_CALL_DELTA_SHAPES)[0]!;
		const shape = resolveResponsesToolCallDeltaShape(provider);
		expect(shape).toBe(RESPONSES_PROVIDER_TOOL_CALL_DELTA_SHAPES[provider]);
	});
	it("returns shape for known provider in object", () => {
		const provider = Object.keys(RESPONSES_PROVIDER_TOOL_CALL_DELTA_SHAPES)[0]!;
		const shape = resolveResponsesToolCallDeltaShape({ provider });
		expect(shape).toBe(RESPONSES_PROVIDER_TOOL_CALL_DELTA_SHAPES[provider]);
	});
	it("falls back to api shape when provider not found", () => {
		const api = Object.keys(RESPONSES_API_TOOL_CALL_DELTA_SHAPES)[0]!;
		const shape = resolveResponsesToolCallDeltaShape({ provider: "unknown-provider", api });
		expect(shape).toBe(RESPONSES_API_TOOL_CALL_DELTA_SHAPES[api]);
	});
	it("falls back to api param when provider not in object", () => {
		const api = Object.keys(RESPONSES_API_TOOL_CALL_DELTA_SHAPES)[0]!;
		const shape = resolveResponsesToolCallDeltaShape("unknown-provider", api);
		expect(shape).toBe(RESPONSES_API_TOOL_CALL_DELTA_SHAPES[api]);
	});
	it("throws for unknown provider and api", () => {
		expect(() => resolveResponsesToolCallDeltaShape("unknown-provider", "unknown-api")).toThrow(
			"Undeclared tool-call argument delta wire shape",
		);
	});
	it("throws for empty provider and undefined api", () => {
		expect(() => resolveResponsesToolCallDeltaShape("")).toThrow();
	});
	it("prefers provider shape over api shape", () => {
		const provider = Object.keys(RESPONSES_PROVIDER_TOOL_CALL_DELTA_SHAPES)[0]!;
		const api = Object.keys(RESPONSES_API_TOOL_CALL_DELTA_SHAPES)[0]!;
		const providerShape = RESPONSES_PROVIDER_TOOL_CALL_DELTA_SHAPES[provider];
		const result = resolveResponsesToolCallDeltaShape({ provider, api });
		expect(result).toBe(providerShape);
	});
	it("handles object with undefined provider and api", () => {
		const api = Object.keys(RESPONSES_API_TOOL_CALL_DELTA_SHAPES)[0]!;
		const shape = resolveResponsesToolCallDeltaShape({ provider: undefined, api });
		expect(shape).toBe(RESPONSES_API_TOOL_CALL_DELTA_SHAPES[api]);
	});
});

describe("mapOpenAIResponsesStopReason", () => {
	it("maps undefined to 'stop'", () => {
		expect(mapOpenAIResponsesStopReason(undefined)).toBe("stop");
	});
	it("maps 'completed' to 'stop'", () => {
		expect(mapOpenAIResponsesStopReason("completed")).toBe("stop");
	});
	it("maps 'incomplete' to 'length'", () => {
		expect(mapOpenAIResponsesStopReason("incomplete")).toBe("length");
	});
	it("maps 'failed' to 'error'", () => {
		expect(mapOpenAIResponsesStopReason("failed")).toBe("error");
	});
	it("maps 'cancelled' to 'error'", () => {
		expect(mapOpenAIResponsesStopReason("cancelled")).toBe("error");
	});
	it("maps 'in_progress' to 'stop'", () => {
		expect(mapOpenAIResponsesStopReason("in_progress")).toBe("stop");
	});
	it("maps 'queued' to 'stop'", () => {
		expect(mapOpenAIResponsesStopReason("queued")).toBe("stop");
	});
});

describe("createInitialResponsesAssistantMessage", () => {
	it("creates message with empty content array", () => {
		const msg = createInitialResponsesAssistantMessage("openai-responses", "openai", "gpt-4o");
		expect(msg.content).toEqual([]);
	});
	it("creates message with correct api", () => {
		const msg = createInitialResponsesAssistantMessage("openai-responses", "openai", "gpt-4o");
		expect(msg.api).toBe("openai-responses");
	});
	it("creates message with correct provider", () => {
		const msg = createInitialResponsesAssistantMessage("openai-responses", "openai", "gpt-4o");
		expect(msg.provider).toBe("openai");
	});
	it("creates message with correct model", () => {
		const msg = createInitialResponsesAssistantMessage("openai-responses", "openai", "gpt-4o");
		expect(msg.model).toBe("gpt-4o");
	});
	it("creates message with stop reason 'stop'", () => {
		const msg = createInitialResponsesAssistantMessage("openai-responses", "openai", "gpt-4o");
		expect(msg.stopReason).toBe("stop");
	});
	it("creates message with role 'assistant'", () => {
		const msg = createInitialResponsesAssistantMessage("openai-responses", "openai", "gpt-4o");
		expect(msg.role).toBe("assistant");
	});
	it("creates message with usage object", () => {
		const msg = createInitialResponsesAssistantMessage("openai-responses", "openai", "gpt-4o");
		expect(msg.usage).toBeDefined();
		expect(typeof msg.usage).toBe("object");
	});
	it("creates message with timestamp", () => {
		const msg = createInitialResponsesAssistantMessage("openai-responses", "openai", "gpt-4o");
		expect(typeof msg.timestamp).toBe("number");
	});
});

describe("promoteResponsesToolUseStopReason", () => {
	it("promotes 'stop' to 'toolUse' when toolCall blocks exist", () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_1", name: "test", arguments: {} } as ToolCall],
			stopReason: "stop",
		} as unknown as AssistantMessage;
		promoteResponsesToolUseStopReason(output, undefined);
		expect(output.stopReason).toBe("toolUse");
	});
	it("does not promote when stopReason is not 'stop'", () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_1", name: "test", arguments: {} } as ToolCall],
			stopReason: "length",
		} as unknown as AssistantMessage;
		promoteResponsesToolUseStopReason(output, undefined);
		expect(output.stopReason).toBe("length");
	});
	it("does not promote when no toolCall blocks", () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			stopReason: "stop",
		} as unknown as AssistantMessage;
		promoteResponsesToolUseStopReason(output, undefined);
		expect(output.stopReason).toBe("stop");
	});
	it("sets pause_turn stopDetails when endTurn is false and stopReason is stop", () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			stopReason: "stop",
		} as unknown as AssistantMessage;
		promoteResponsesToolUseStopReason(output, false);
		expect(output.stopDetails).toEqual({ type: "pause_turn" });
	});
	it("does not set pause_turn when endTurn is true", () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			stopReason: "stop",
		} as unknown as AssistantMessage;
		promoteResponsesToolUseStopReason(output, true);
		expect(output.stopDetails).toBeUndefined();
	});
	it("does not set pause_turn when endTurn is undefined", () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			stopReason: "stop",
		} as unknown as AssistantMessage;
		promoteResponsesToolUseStopReason(output, undefined);
		expect(output.stopDetails).toBeUndefined();
	});
});

describe("finalizePendingResponsesToolCalls", () => {
	it("does nothing for empty content", () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			stopReason: "stop",
		} as unknown as AssistantMessage;
		finalizePendingResponsesToolCalls(output);
		expect(output.content).toEqual([]);
	});
	it("does nothing for non-toolCall blocks", () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			stopReason: "stop",
		} as unknown as AssistantMessage;
		finalizePendingResponsesToolCalls(output);
		expect(output.content[0]).toEqual({ type: "text", text: "hello" });
	});
	it("parses pending JSON for toolCall blocks with streaming partial", () => {
		const block = {
			type: "toolCall",
			id: "call_1",
			name: "test",
			arguments: {},
			[kStreamingPartialJson]: '{"key":"value"}',
		} as unknown as ToolCall;
		const output: AssistantMessage = {
			role: "assistant",
			content: [block],
			stopReason: "stop",
		} as unknown as AssistantMessage;
		finalizePendingResponsesToolCalls(output);
		expect((output.content[0] as ToolCall).arguments).toEqual({ key: "value" });
	});
	it("handles custom wire name tool calls", () => {
		const block = {
			type: "toolCall",
			id: "call_1",
			name: "test",
			arguments: {},
			customWireName: "edit",
			[kStreamingPartialJson]: "raw input text",
		} as unknown as ToolCall;
		const output: AssistantMessage = {
			role: "assistant",
			content: [block],
			stopReason: "stop",
		} as unknown as AssistantMessage;
		finalizePendingResponsesToolCalls(output);
		expect((output.content[0] as ToolCall).arguments).toEqual({ input: "raw input text" });
	});
});
