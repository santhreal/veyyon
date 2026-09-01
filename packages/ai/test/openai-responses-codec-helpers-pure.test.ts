import { describe, expect, it } from "bun:test";
import {
	appendReasoningSummaryPart,
	collectCustomCallIds,
	collectKnownCallIds,
	createSequentialCutoffSummaryState,
	encodeResponsesToolCallId,
	encodeTextSignatureV1,
	finalizeReasoningThinking,
	foldReasoningSummary,
	isOpenAIResponsesProgressEvent,
	OPENAI_RESPONSES_PROGRESS_EVENT_TYPES,
	ORPHAN_TOOL_CALL_PLACEHOLDER,
	parseTextSignature,
	repairOrphanResponsesToolCalls,
	repairOrphanResponsesToolOutputs,
} from "../src/providers/openai-responses-codec-helpers";
import type { ResponseInput, ResponseReasoningItem } from "../src/providers/openai-responses-wire";

describe("encodeTextSignatureV1", () => {
	it("encodes id without phase", () => {
		const result = encodeTextSignatureV1("abc123");
		const parsed = JSON.parse(result);
		expect(parsed.v).toBe(1);
		expect(parsed.id).toBe("abc123");
		expect(parsed.phase).toBeUndefined();
	});
	it("encodes id with phase", () => {
		const result = encodeTextSignatureV1("abc123", "commentary");
		const parsed = JSON.parse(result);
		expect(parsed.v).toBe(1);
		expect(parsed.id).toBe("abc123");
		expect(parsed.phase).toBe("commentary");
	});
	it("encodes id with final_answer phase", () => {
		const result = encodeTextSignatureV1("abc123", "final_answer");
		const parsed = JSON.parse(result);
		expect(parsed.phase).toBe("final_answer");
	});
	it("produces valid JSON starting with {", () => {
		expect(encodeTextSignatureV1("x").startsWith("{")).toBe(true);
	});
});

describe("parseTextSignature", () => {
	it("returns undefined for undefined input", () => {
		expect(parseTextSignature(undefined)).toBeUndefined();
	});
	it("returns undefined for empty string", () => {
		expect(parseTextSignature("")).toBeUndefined();
	});
	it("parses v1 JSON with id only", () => {
		expect(parseTextSignature('{"v":1,"id":"abc"}')).toEqual({ id: "abc" });
	});
	it("parses v1 JSON with commentary phase", () => {
		expect(parseTextSignature('{"v":1,"id":"abc","phase":"commentary"}')).toEqual({
			id: "abc",
			phase: "commentary",
		});
	});
	it("parses v1 JSON with final_answer phase", () => {
		expect(parseTextSignature('{"v":1,"id":"abc","phase":"final_answer"}')).toEqual({
			id: "abc",
			phase: "final_answer",
		});
	});
	it("returns {id} for non-v1 JSON", () => {
		expect(parseTextSignature('{"v":2,"id":"abc"}')).toEqual({ id: '{"v":2,"id":"abc"}' });
	});
	it("returns {id} for invalid JSON starting with {", () => {
		expect(parseTextSignature("{invalid}")).toEqual({ id: "{invalid}" });
	});
	it("returns {id} for plain string", () => {
		expect(parseTextSignature("plain-id")).toEqual({ id: "plain-id" });
	});
	it("returns {id} for string with special chars", () => {
		expect(parseTextSignature("id|with|pipes")).toEqual({ id: "id|with|pipes" });
	});
	it("ignores unknown phase values", () => {
		expect(parseTextSignature('{"v":1,"id":"abc","phase":"unknown_phase"}')).toEqual({ id: "abc" });
	});
});

describe("encodeResponsesToolCallId", () => {
	it("encodes with provided itemId", () => {
		expect(encodeResponsesToolCallId("call_123", "item_456")).toBe("call_123|item_456");
	});
	it("encodes with null itemId using hash fallback", () => {
		const result = encodeResponsesToolCallId("call_123", null);
		expect(result).toMatch(/^call_123\|fc_/);
	});
	it("encodes with undefined itemId using hash fallback", () => {
		const result = encodeResponsesToolCallId("call_123", undefined);
		expect(result).toMatch(/^call_123\|fc_/);
	});
	it("encodes with empty string itemId using hash fallback", () => {
		const result = encodeResponsesToolCallId("call_123", "");
		expect(result).toMatch(/^call_123\|fc_/);
	});
	it("produces deterministic hash for same callId", () => {
		const r1 = encodeResponsesToolCallId("call_x", null);
		const r2 = encodeResponsesToolCallId("call_x", null);
		expect(r1).toBe(r2);
	});
	it("produces different hashes for different callIds", () => {
		const r1 = encodeResponsesToolCallId("call_a", null);
		const r2 = encodeResponsesToolCallId("call_b", null);
		expect(r1).not.toBe(r2);
	});
});

describe("isOpenAIResponsesProgressEvent", () => {
	it("returns false for null", () => {
		expect(isOpenAIResponsesProgressEvent(null)).toBe(false);
	});
	it("returns false for non-object", () => {
		expect(isOpenAIResponsesProgressEvent("string")).toBe(false);
	});
	it("returns false for object without type", () => {
		expect(isOpenAIResponsesProgressEvent({})).toBe(false);
	});
	it("returns false for object with non-string type", () => {
		expect(isOpenAIResponsesProgressEvent({ type: 123 })).toBe(false);
	});
	it("returns false for unknown event type", () => {
		expect(isOpenAIResponsesProgressEvent({ type: "unknown_event" })).toBe(false);
	});
	it("returns true for known progress event type", () => {
		const firstType = OPENAI_RESPONSES_PROGRESS_EVENT_TYPES.values().next().value;
		expect(isOpenAIResponsesProgressEvent({ type: firstType })).toBe(true);
	});
});

describe("collectKnownCallIds", () => {
	it("returns empty set for empty input", () => {
		expect(collectKnownCallIds([]).size).toBe(0);
	});
	it("collects call_ids from function_call items", () => {
		const input = [
			{ type: "function_call", call_id: "call_1" },
			{ type: "function_call", call_id: "call_2" },
		] as unknown as ResponseInput;
		const result = collectKnownCallIds(input);
		expect(result.has("call_1")).toBe(true);
		expect(result.has("call_2")).toBe(true);
		expect(result.size).toBe(2);
	});
	it("ignores non-function_call items", () => {
		const input = [
			{ type: "message", call_id: "call_1" },
			{ type: "text", id: "msg_1" },
		] as unknown as ResponseInput;
		const result = collectKnownCallIds(input);
		expect(result.size).toBe(0);
	});
});

describe("collectCustomCallIds", () => {
	it("returns empty set for empty input", () => {
		expect(collectCustomCallIds([]).size).toBe(0);
	});
	it("collects call_ids from custom_tool_call items", () => {
		const input = [
			{ type: "custom_tool_call", call_id: "custom_1" },
			{ type: "custom_tool_call", call_id: "custom_2" },
		] as unknown as ResponseInput;
		const result = collectCustomCallIds(input);
		expect(result.has("custom_1")).toBe(true);
		expect(result.has("custom_2")).toBe(true);
	});
	it("ignores non-custom_tool_call items", () => {
		const input = [{ type: "function_call", call_id: "call_1" }] as unknown as ResponseInput;
		expect(collectCustomCallIds(input).size).toBe(0);
	});
});

describe("ORPHAN_TOOL_CALL_PLACEHOLDER", () => {
	it("is a non-empty string", () => {
		expect(ORPHAN_TOOL_CALL_PLACEHOLDER.length).toBeGreaterThan(0);
	});
	it("mentions interruption", () => {
		expect(ORPHAN_TOOL_CALL_PLACEHOLDER.toLowerCase()).toContain("interrupted");
	});
});

describe("repairOrphanResponsesToolOutputs", () => {
	it("returns input as-is when no orphans", () => {
		const input = [{ type: "message", role: "user", content: "hello" }] as unknown as ResponseInput;
		expect(repairOrphanResponsesToolOutputs(input)).toBe(input);
	});
	it("returns input as-is for empty input", () => {
		const input: ResponseInput = [];
		expect(repairOrphanResponsesToolOutputs(input)).toBe(input);
	});
});

describe("repairOrphanResponsesToolCalls", () => {
	it("returns input as-is for empty input", () => {
		const input: ResponseInput = [];
		expect(repairOrphanResponsesToolCalls(input)).toBe(input);
	});
});

describe("createSequentialCutoffSummaryState", () => {
	it("returns state with empty summary array", () => {
		const state = createSequentialCutoffSummaryState();
		expect(state.summary).toEqual([]);
	});
	it("returns state with empty emitted string", () => {
		const state = createSequentialCutoffSummaryState();
		expect(state.emitted).toBe("");
	});
});

describe("foldReasoningSummary", () => {
	it("returns empty string for undefined parts", () => {
		expect(foldReasoningSummary(undefined)).toBe("");
	});
	it("returns empty string for empty array", () => {
		expect(foldReasoningSummary([])).toBe("");
	});
	it("returns text of single part", () => {
		expect(foldReasoningSummary([{ type: "summary_text", text: "hello" }])).toBe("hello");
	});
	it("concatenates non-extending parts with double newline", () => {
		const parts = [
			{ type: "summary_text" as const, text: "first" },
			{ type: "summary_text" as const, text: "second" },
		];
		expect(foldReasoningSummary(parts)).toBe("first\n\nsecond");
	});
	it("extends canonical when next part starts with canonical + newline", () => {
		const parts = [
			{ type: "summary_text" as const, text: "first" },
			{ type: "summary_text" as const, text: "first\n\nsecond" },
		];
		expect(foldReasoningSummary(parts)).toBe("first\n\nsecond");
	});
	it("skips empty text parts", () => {
		const parts = [
			{ type: "summary_text" as const, text: "" },
			{ type: "summary_text" as const, text: "real" },
		];
		expect(foldReasoningSummary(parts)).toBe("real");
	});
	it("skips duplicate text parts", () => {
		const parts = [
			{ type: "summary_text" as const, text: "same" },
			{ type: "summary_text" as const, text: "same" },
		];
		expect(foldReasoningSummary(parts)).toBe("same");
	});
});

describe("appendReasoningSummaryPart", () => {
	it("creates summary array when undefined", () => {
		const item: ResponseReasoningItem = {
			type: "reasoning",
			id: "r1",
			summary: [],
		} as unknown as ResponseReasoningItem;
		(item as { summary?: unknown }).summary = undefined;
		appendReasoningSummaryPart(item, { type: "summary_text", text: "part1" });
		expect(item.summary).toEqual([{ type: "summary_text", text: "part1" }]);
	});
	it("appends to existing summary array", () => {
		const item: ResponseReasoningItem = {
			type: "reasoning",
			id: "r1",
			summary: [{ type: "summary_text", text: "part1" }],
		} as unknown as ResponseReasoningItem;
		appendReasoningSummaryPart(item, { type: "summary_text", text: "part2" });
		expect(item.summary?.length).toBe(2);
		expect(item.summary?.[1]?.text).toBe("part2");
	});
});

describe("finalizeReasoningThinking", () => {
	it("returns streamedThinking when no summary or content", () => {
		const item = { type: "reasoning", id: "r1" } as unknown as ResponseReasoningItem;
		expect(finalizeReasoningThinking(item, "streamed")).toBe("streamed");
	});
	it("returns summary thinking joined by double newlines", () => {
		const item = {
			type: "reasoning",
			id: "r1",
			summary: [
				{ type: "summary_text", text: "part1" },
				{ type: "summary_text", text: "part2" },
			],
		} as unknown as ResponseReasoningItem;
		expect(finalizeReasoningThinking(item, "")).toBe("part1\n\npart2");
	});
	it("returns content thinking when no summary", () => {
		const item = {
			type: "reasoning",
			id: "r1",
			content: [{ type: "reasoning_text", text: "content thinking" }],
		} as unknown as ResponseReasoningItem;
		expect(finalizeReasoningThinking(item, "")).toBe("content thinking");
	});
	it("prefers summary over content", () => {
		const item = {
			type: "reasoning",
			id: "r1",
			summary: [{ type: "summary_text", text: "from summary" }],
			content: [{ type: "reasoning_text", text: "from content" }],
		} as unknown as ResponseReasoningItem;
		expect(finalizeReasoningThinking(item, "")).toBe("from summary");
	});
	it("returns streamed thinking when no summary and no content", () => {
		const item = { type: "reasoning", id: "r1" } as unknown as ResponseReasoningItem;
		expect(finalizeReasoningThinking(item, "fallback")).toBe("fallback");
	});
	it("returns empty string when nothing available", () => {
		const item = { type: "reasoning", id: "r1" } as unknown as ResponseReasoningItem;
		expect(finalizeReasoningThinking(item, "")).toBe("");
	});
	it("uses cutoff path when cutoff provided", () => {
		const item = { type: "reasoning", id: "r1" } as unknown as ResponseReasoningItem;
		const cutoff = createSequentialCutoffSummaryState();
		expect(finalizeReasoningThinking(item, "streamed", cutoff)).toBe("streamed");
	});
});
