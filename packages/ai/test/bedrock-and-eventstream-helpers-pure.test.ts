import { describe, expect, it } from "bun:test";
import { mapStopReason, safeParsePayload } from "../src/providers/amazon-bedrock-helpers";
import { crc32, decodeMessage } from "../src/providers/aws-eventstream";
import { supportsBedrockPromptCaching } from "../src/providers/bedrock-prompt-cache";
import type { Model } from "../src/types";

describe("safeParsePayload", () => {
	it("returns {} for empty Uint8Array", () => {
		expect(safeParsePayload(new Uint8Array(0))).toEqual({});
	});
	it("parses valid JSON payload", () => {
		const payload = new TextEncoder().encode('{"key":"value"}');
		expect(safeParsePayload(payload)).toEqual({ key: "value" });
	});
	it("returns undefined for invalid JSON", () => {
		const payload = new TextEncoder().encode("invalid json");
		expect(safeParsePayload(payload)).toBeUndefined();
	});
	it("parses array payload", () => {
		const payload = new TextEncoder().encode("[1,2,3]");
		expect(safeParsePayload(payload)).toEqual([1, 2, 3]);
	});
	it("parses number payload", () => {
		const payload = new TextEncoder().encode("42");
		expect(safeParsePayload(payload)).toBe(42);
	});
	it("parses string payload", () => {
		const payload = new TextEncoder().encode('"hello"');
		expect(safeParsePayload(payload)).toBe("hello");
	});
	it("parses null payload", () => {
		const payload = new TextEncoder().encode("null");
		expect(safeParsePayload(payload)).toBeNull();
	});
	it("parses boolean payload", () => {
		const payload = new TextEncoder().encode("true");
		expect(safeParsePayload(payload)).toBe(true);
	});
	it("parses nested object payload", () => {
		const payload = new TextEncoder().encode('{"a":{"b":[1,2]}}');
		expect(safeParsePayload(payload)).toEqual({ a: { b: [1, 2] } });
	});
});

describe("mapStopReason", () => {
	it("maps 'end_turn' to 'stop'", () => {
		expect(mapStopReason("end_turn")).toBe("stop");
	});
	it("maps 'stop_sequence' to 'stop'", () => {
		expect(mapStopReason("stop_sequence")).toBe("stop");
	});
	it("maps 'max_tokens' to 'length'", () => {
		expect(mapStopReason("max_tokens")).toBe("length");
	});
	it("maps 'model_context_window_exceeded' to 'length'", () => {
		expect(mapStopReason("model_context_window_exceeded")).toBe("length");
	});
	it("maps 'tool_use' to 'toolUse'", () => {
		expect(mapStopReason("tool_use")).toBe("toolUse");
	});
	it("maps undefined to 'error'", () => {
		expect(mapStopReason(undefined)).toBe("error");
	});
	it("maps unknown string to 'error'", () => {
		expect(mapStopReason("unknown_reason")).toBe("error");
	});
	it("maps empty string to 'error'", () => {
		expect(mapStopReason("")).toBe("error");
	});
});

describe("crc32", () => {
	it("returns 0 for empty array", () => {
		expect(crc32(new Uint8Array(0))).toBe(0);
	});
	it("returns correct CRC for 'hello'", () => {
		const data = new TextEncoder().encode("hello");
		expect(crc32(data)).toBe(0x3610a686);
	});
	it("returns unsigned 32-bit value", () => {
		const data = new TextEncoder().encode("test data for crc32");
		const result = crc32(data);
		expect(result).toBeGreaterThanOrEqual(0);
		expect(result).toBeLessThanOrEqual(0xffffffff);
	});
	it("is deterministic", () => {
		const data = new TextEncoder().encode("deterministic test");
		expect(crc32(data)).toBe(crc32(data));
	});
	it("handles single byte", () => {
		expect(crc32(new Uint8Array([65]))).toBe(crc32(new Uint8Array([65])));
	});
});

describe("decodeMessage", () => {
	it("throws on frame too short", () => {
		const shortFrame = new Uint8Array(4);
		expect(() => decodeMessage(shortFrame)).toThrow();
	});
	it("throws on length mismatch", () => {
		const frame = new Uint8Array(20);
		const view = new DataView(frame.buffer);
		view.setUint32(0, 100, false);
		expect(() => decodeMessage(frame)).toThrow();
	});
});

describe("supportsBedrockPromptCaching", () => {
	it("returns true for claude-4 model with cache cost", () => {
		const model = {
			provider: "bedrock-converse-stream",
			api: "bedrock-converse-stream",
			id: "anthropic.claude-4-sonnet-20250514-v1:0",
			cost: { cacheRead: 0.5, cacheWrite: 1 },
		} as unknown as Model<"bedrock-converse-stream">;
		expect(supportsBedrockPromptCaching(model)).toBe(true);
	});
	it("returns true for claude-3-7-sonnet", () => {
		const model = {
			provider: "bedrock-converse-stream",
			api: "bedrock-converse-stream",
			id: "anthropic.claude-3-7-sonnet-20250219-v1:0",
			cost: {},
		} as unknown as Model<"bedrock-converse-stream">;
		expect(supportsBedrockPromptCaching(model)).toBe(true);
	});
	it("returns true for claude-3-5-haiku", () => {
		const model = {
			provider: "bedrock-converse-stream",
			api: "bedrock-converse-stream",
			id: "anthropic.claude-3-5-haiku-20241022-v1:0",
			cost: {},
		} as unknown as Model<"bedrock-converse-stream">;
		expect(supportsBedrockPromptCaching(model)).toBe(true);
	});
	it("returns true for claude-haiku", () => {
		const model = {
			provider: "bedrock-converse-stream",
			api: "bedrock-converse-stream",
			id: "anthropic.claude-haiku-20250310-v1:0",
			cost: {},
		} as unknown as Model<"bedrock-converse-stream">;
		expect(supportsBedrockPromptCaching(model)).toBe(true);
	});
	it("returns false for non-claude model without cache cost", () => {
		const model = {
			provider: "bedrock-converse-stream",
			api: "bedrock-converse-stream",
			id: "amazon.titan-text-express-v1",
			cost: {},
		} as unknown as Model<"bedrock-converse-stream">;
		expect(supportsBedrockPromptCaching(model)).toBe(false);
	});
	it("returns true when cacheRead cost is set", () => {
		const model = {
			provider: "bedrock-converse-stream",
			api: "bedrock-converse-stream",
			id: "amazon.titan-text-express-v1",
			cost: { cacheRead: 0.5 },
		} as unknown as Model<"bedrock-converse-stream">;
		expect(supportsBedrockPromptCaching(model)).toBe(true);
	});
	it("returns true when cacheWrite cost is set", () => {
		const model = {
			provider: "bedrock-converse-stream",
			api: "bedrock-converse-stream",
			id: "amazon.titan-text-express-v1",
			cost: { cacheWrite: 1 },
		} as unknown as Model<"bedrock-converse-stream">;
		expect(supportsBedrockPromptCaching(model)).toBe(true);
	});
});
