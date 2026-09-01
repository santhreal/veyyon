import { describe, expect, it } from "bun:test";
import {
	assistantContentToOtelParts,
	detectGatewayFromHeaders,
	limitTelemetryMessages,
	limitTelemetryToolCalls,
	MAX_TELEMETRY_ARRAY_ITEMS,
	MAX_TELEMETRY_MESSAGE_COUNT,
	MAX_TELEMETRY_OBJECT_DEPTH,
	MAX_TELEMETRY_OBJECT_KEYS,
	MAX_TELEMETRY_TEXT_CHARS,
	mapStopReason,
	summarizeTelemetryText,
	summarizeTelemetryTexts,
	summarizeTelemetryValue,
} from "../src/telemetry-helpers";

describe("telemetry constants", () => {
	it("MAX_TELEMETRY_ARRAY_ITEMS is 64", () => {
		expect(MAX_TELEMETRY_ARRAY_ITEMS).toBe(64);
	});
	it("MAX_TELEMETRY_MESSAGE_COUNT is 16", () => {
		expect(MAX_TELEMETRY_MESSAGE_COUNT).toBe(16);
	});
	it("MAX_TELEMETRY_OBJECT_DEPTH is 3", () => {
		expect(MAX_TELEMETRY_OBJECT_DEPTH).toBe(3);
	});
	it("MAX_TELEMETRY_OBJECT_KEYS is 12", () => {
		expect(MAX_TELEMETRY_OBJECT_KEYS).toBe(12);
	});
	it("MAX_TELEMETRY_TEXT_CHARS is 240", () => {
		expect(MAX_TELEMETRY_TEXT_CHARS).toBe(240);
	});
});

describe("summarizeTelemetryText", () => {
	it("returns text unchanged when under limit", () => {
		expect(summarizeTelemetryText("hello")).toBe("hello");
	});
	it("truncates text over limit with omission marker", () => {
		const longText = "a".repeat(MAX_TELEMETRY_TEXT_CHARS + 100);
		const result = summarizeTelemetryText(longText);
		expect(result.length).toBeLessThan(longText.length);
		expect(result).toContain("chars omitted");
	});
	it("returns text unchanged at exactly the limit", () => {
		const text = "a".repeat(MAX_TELEMETRY_TEXT_CHARS);
		expect(summarizeTelemetryText(text)).toBe(text);
	});
	it("handles empty string", () => {
		expect(summarizeTelemetryText("")).toBe("");
	});
});

describe("summarizeTelemetryTexts", () => {
	it("summarizes each text in array", () => {
		expect(summarizeTelemetryTexts(["hello", "world"])).toEqual(["hello", "world"]);
	});
	it("limits array to max items", () => {
		const texts = Array.from({ length: MAX_TELEMETRY_ARRAY_ITEMS + 10 }, (_, i) => `text_${i}`);
		const result = summarizeTelemetryTexts(texts);
		expect(result.length).toBe(MAX_TELEMETRY_ARRAY_ITEMS + 1);
		expect(result[result.length - 1]).toContain("additional text entries omitted");
	});
	it("handles empty array", () => {
		expect(summarizeTelemetryTexts([])).toEqual([]);
	});
});

describe("summarizeTelemetryValue", () => {
	it("returns string summarized", () => {
		expect(summarizeTelemetryValue("hello")).toBe("hello");
	});
	it("returns number unchanged", () => {
		expect(summarizeTelemetryValue(42)).toBe(42);
	});
	it("returns boolean unchanged", () => {
		expect(summarizeTelemetryValue(true)).toBe(true);
	});
	it("returns null unchanged", () => {
		expect(summarizeTelemetryValue(null)).toBeNull();
	});
	it("returns undefined unchanged", () => {
		expect(summarizeTelemetryValue(undefined)).toBeUndefined();
	});
	it("returns bigint as string", () => {
		expect(summarizeTelemetryValue(42n)).toBe("42");
	});
	it("returns function as [Function]", () => {
		expect(summarizeTelemetryValue(() => {})).toBe("[Function]");
	});
	it("summarizes Error objects", () => {
		const err = new Error("test error");
		const result = summarizeTelemetryValue(err) as { name: string; message: string };
		expect(result.name).toBe("Error");
		expect(result.message).toBe("test error");
	});
	it("summarizes arrays", () => {
		const result = summarizeTelemetryValue([1, 2, 3]) as unknown[];
		expect(result).toHaveLength(3);
		expect(result[0]).toBe(1);
	});
	it("summarizes arrays at max depth", () => {
		const deep = { a: { b: { c: { d: [1, 2] } } } };
		const result = summarizeTelemetryValue(deep);
		expect(typeof result).toBe("object");
	});
	it("truncates large arrays", () => {
		const arr = Array.from({ length: MAX_TELEMETRY_ARRAY_ITEMS + 10 }, (_, i) => i);
		const result = summarizeTelemetryValue(arr) as unknown[];
		expect(result.length).toBe(MAX_TELEMETRY_ARRAY_ITEMS + 1);
		const last = result[result.length - 1] as { kind: string; omittedItems: number };
		expect(last.kind).toBe("truncated");
	});
	it("summarizes plain objects", () => {
		const result = summarizeTelemetryValue({ a: 1, b: "hello" }) as Record<string, unknown>;
		expect(result.a).toBe(1);
		expect(result.b).toBe("hello");
	});
	it("truncates objects with too many keys", () => {
		const obj: Record<string, number> = {};
		for (let i = 0; i < MAX_TELEMETRY_OBJECT_KEYS + 5; i++) obj[`key_${i}`] = i;
		const result = summarizeTelemetryValue(obj) as Record<string, unknown>;
		expect(result.telemetrySummary).toBeDefined();
	});
	it("handles circular references in arrays", () => {
		const arr: unknown[] = [1, 2];
		arr.push(arr);
		const result = summarizeTelemetryValue(arr) as unknown[];
		expect(result[2]).toBe("[Circular]");
	});
	it("handles circular references in objects", () => {
		const obj: Record<string, unknown> = { a: 1 };
		obj.self = obj;
		const result = summarizeTelemetryValue(obj) as Record<string, unknown>;
		expect(result.self).toBe("[Circular]");
	});
	it("returns string representation for non-plain objects", () => {
		const date = new Date();
		const result = summarizeTelemetryValue(date);
		expect(typeof result).toBe("string");
	});
});

describe("limitTelemetryMessages", () => {
	it("returns messages unchanged when under limit", () => {
		const messages = [{ role: "user", content: { kind: "text", text: "hello" } }];
		expect(limitTelemetryMessages(messages)).toEqual(messages);
	});
	it("truncates messages over limit with system message", () => {
		const messages = Array.from({ length: MAX_TELEMETRY_MESSAGE_COUNT + 5 }, () => ({
			role: "user" as const,
			content: { kind: "text" as const, text: "hello" },
		}));
		const result = limitTelemetryMessages(messages);
		expect(result.length).toBe(MAX_TELEMETRY_MESSAGE_COUNT + 1);
		const last = result[result.length - 1] as { role: string; content: { kind: string; omittedMessages: number } };
		expect(last.role).toBe("system");
		expect(last.content.omittedMessages).toBe(5);
	});
	it("handles empty array", () => {
		expect(limitTelemetryMessages([])).toEqual([]);
	});
});

describe("limitTelemetryToolCalls", () => {
	it("returns tool calls unchanged when under limit", () => {
		const calls = [{ toolCallId: "1", toolName: "foo", input: { kind: "text", text: "hello" } }];
		expect(limitTelemetryToolCalls(calls)).toEqual(calls);
	});
	it("truncates tool calls over limit", () => {
		const calls = Array.from({ length: MAX_TELEMETRY_ARRAY_ITEMS + 5 }, (_, i) => ({
			toolCallId: `call_${i}`,
			toolName: "foo",
			input: { kind: "text" as const, text: "hello" },
		}));
		const result = limitTelemetryToolCalls(calls);
		expect(result.length).toBe(MAX_TELEMETRY_ARRAY_ITEMS + 1);
		const last = result[result.length - 1] as { toolCallId: string; toolName: string };
		expect(last.toolCallId).toBe("[truncated]");
	});
});

describe("mapStopReason", () => {
	it("maps 'stop' to 'stop'", () => {
		expect(mapStopReason("stop")).toBe("stop");
	});
	it("maps 'length' to 'length'", () => {
		expect(mapStopReason("length")).toBe("length");
	});
	it("maps 'toolUse' to 'tool_calls'", () => {
		expect(mapStopReason("toolUse")).toBe("tool_calls");
	});
	it("maps 'error' to 'error'", () => {
		expect(mapStopReason("error")).toBe("error");
	});
	it("maps 'aborted' to 'error'", () => {
		expect(mapStopReason("aborted")).toBe("error");
	});
	it("maps undefined to undefined", () => {
		expect(mapStopReason(undefined)).toBeUndefined();
	});
});

describe("detectGatewayFromHeaders", () => {
	it("returns undefined for no headers", () => {
		expect(detectGatewayFromHeaders(undefined)).toBeUndefined();
	});
	it("returns undefined for empty headers", () => {
		expect(detectGatewayFromHeaders({})).toBeUndefined();
	});
	it("detects litellm gateway", () => {
		const result = detectGatewayFromHeaders({ "x-litellm-call-id": "call_123" });
		expect(result?.name).toBe("litellm");
		expect(result?.callId).toBe("call_123");
	});
	it("detects litellm gateway with model routing", () => {
		const result = detectGatewayFromHeaders({
			"x-litellm-call-id": "call_123",
			"x-litellm-model-id": "gpt-4",
		});
		expect(result?.routedTo).toBe("gpt-4");
	});
	it("detects helicone gateway", () => {
		const result = detectGatewayFromHeaders({ "helicone-id": "h_123" });
		expect(result?.name).toBe("helicone");
		expect(result?.callId).toBe("h_123");
	});
	it("detects portkey gateway via trace id", () => {
		const result = detectGatewayFromHeaders({ "x-portkey-trace-id": "trace_123" });
		expect(result?.name).toBe("portkey");
		expect(result?.callId).toBe("trace_123");
	});
	it("detects portkey gateway via request id", () => {
		const result = detectGatewayFromHeaders({ "x-portkey-request-id": "req_123" });
		expect(result?.name).toBe("portkey");
	});
	it("detects openrouter gateway", () => {
		const result = detectGatewayFromHeaders({ "x-generation-id": "gen-12345" });
		expect(result?.name).toBe("openrouter");
		expect(result?.callId).toBe("gen-12345");
	});
	it("does not detect openrouter for non-gen prefix", () => {
		const result = detectGatewayFromHeaders({ "x-generation-id": "abc-123" });
		expect(result).toBeUndefined();
	});
	it("handles case-insensitive header names", () => {
		const result = detectGatewayFromHeaders({ "X-Litellm-Call-Id": "call_123" });
		expect(result?.name).toBe("litellm");
	});
});

describe("assistantContentToOtelParts", () => {
	it("converts text block", () => {
		const parts = assistantContentToOtelParts([{ type: "text", text: "hello" }]);
		expect(parts).toHaveLength(1);
		expect(parts[0]).toEqual({ type: "text", content: "hello" });
	});
	it("converts thinking block", () => {
		const parts = assistantContentToOtelParts([{ type: "thinking", thinking: "hmm" }]);
		expect(parts[0]).toEqual({ type: "reasoning", content: "hmm" });
	});
	it("converts redactedThinking block", () => {
		const parts = assistantContentToOtelParts([{ type: "redactedThinking", data: "redacted" }]);
		expect(parts[0]).toEqual({ type: "reasoning", content: "redacted" });
	});
	it("converts toolCall block", () => {
		const parts = assistantContentToOtelParts([
			{ type: "toolCall", id: "call_1", name: "getWeather", arguments: { city: "NYC" } },
		]);
		expect(parts[0]).toEqual({
			type: "tool_call",
			id: "call_1",
			name: "getWeather",
			arguments: { city: "NYC" },
		});
	});
	it("handles empty content", () => {
		expect(assistantContentToOtelParts([])).toEqual([]);
	});
	it("converts mixed content blocks", () => {
		const parts = assistantContentToOtelParts([
			{ type: "text", text: "hello" },
			{ type: "toolCall", id: "call_1", name: "foo", arguments: {} },
		]);
		expect(parts).toHaveLength(2);
		expect(parts[0]!.type).toBe("text");
		expect(parts[1]!.type).toBe("tool_call");
	});
});
