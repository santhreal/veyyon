import { describe, expect, it } from "bun:test";
import {
	collectCustomCallIds,
	collectKnownCallIds,
	createSequentialCutoffSummaryState,
	encodeTextSignatureV1,
	finalizeReasoningThinking,
	foldReasoningSummary,
	isOpenAIResponsesProgressEvent,
	OPENAI_RESPONSES_PROGRESS_EVENT_TYPES,
	ORPHAN_TOOL_CALL_PLACEHOLDER,
	parseTextSignature,
	repairOrphanResponsesToolCalls,
} from "../src/providers/openai-responses-codec-helpers";

describe("OPENAI_RESPONSES_PROGRESS_EVENT_TYPES", () => {
	it("includes response.created", () => {
		expect(OPENAI_RESPONSES_PROGRESS_EVENT_TYPES.has("response.created")).toBe(true);
	});
	it("includes response.completed", () => {
		expect(OPENAI_RESPONSES_PROGRESS_EVENT_TYPES.has("response.completed")).toBe(true);
	});
	it("includes error", () => {
		expect(OPENAI_RESPONSES_PROGRESS_EVENT_TYPES.has("error")).toBe(true);
	});
	it("does not include unrelated type", () => {
		expect(OPENAI_RESPONSES_PROGRESS_EVENT_TYPES.has("unrelated")).toBe(false);
	});
});

describe("isOpenAIResponsesProgressEvent", () => {
	it("returns true for known event type", () => {
		expect(isOpenAIResponsesProgressEvent({ type: "response.created" })).toBe(true);
	});
	it("returns false for unknown event type", () => {
		expect(isOpenAIResponsesProgressEvent({ type: "unknown" })).toBe(false);
	});
	it("returns false for null", () => {
		expect(isOpenAIResponsesProgressEvent(null)).toBe(false);
	});
	it("returns false for non-object", () => {
		expect(isOpenAIResponsesProgressEvent("string")).toBe(false);
	});
	it("returns false for object without type", () => {
		expect(isOpenAIResponsesProgressEvent({ data: 1 })).toBe(false);
	});
	it("returns false for non-string type", () => {
		expect(isOpenAIResponsesProgressEvent({ type: 42 })).toBe(false);
	});
});

describe("encodeTextSignatureV1", () => {
	it("encodes id without phase", () => {
		const result = encodeTextSignatureV1("abc");
		expect(JSON.parse(result)).toEqual({ v: 1, id: "abc" });
	});
	it("encodes id with phase", () => {
		const result = encodeTextSignatureV1("abc", "commentary");
		expect(JSON.parse(result)).toEqual({ v: 1, id: "abc", phase: "commentary" });
	});
	it("encodes id with final_answer phase", () => {
		const result = encodeTextSignatureV1("xyz", "final_answer");
		expect(JSON.parse(result)).toEqual({ v: 1, id: "xyz", phase: "final_answer" });
	});
	it("does not include phase when undefined", () => {
		const result = encodeTextSignatureV1("abc", undefined);
		const parsed = JSON.parse(result) as { phase?: string };
		expect(parsed.phase).toBeUndefined();
	});
});

describe("parseTextSignature", () => {
	it("returns undefined for undefined input", () => {
		expect(parseTextSignature(undefined)).toBeUndefined();
	});
	it("returns undefined for empty string", () => {
		expect(parseTextSignature("")).toBeUndefined();
	});
	it("parses v1 signature with id", () => {
		expect(parseTextSignature('{"v":1,"id":"abc"}')).toEqual({ id: "abc" });
	});
	it("parses v1 signature with phase", () => {
		expect(parseTextSignature('{"v":1,"id":"abc","phase":"commentary"}')).toEqual({ id: "abc", phase: "commentary" });
	});
	it("returns {id} for non-JSON string", () => {
		expect(parseTextSignature("plain-id")).toEqual({ id: "plain-id" });
	});
	it("returns {id} for invalid JSON", () => {
		expect(parseTextSignature("{invalid")).toEqual({ id: "{invalid" });
	});
	it("returns {id} for JSON without v=1", () => {
		expect(parseTextSignature('{"v":2,"id":"abc"}')).toEqual({ id: '{"v":2,"id":"abc"}' });
	});
	it("returns {id} for JSON without id", () => {
		expect(parseTextSignature('{"v":1}')).toEqual({ id: '{"v":1}' });
	});
	it("ignores invalid phase value", () => {
		expect(parseTextSignature('{"v":1,"id":"abc","phase":"invalid"}')).toEqual({ id: "abc" });
	});
});

describe("ORPHAN_TOOL_CALL_PLACEHOLDER", () => {
	it("is a non-empty string", () => {
		expect(ORPHAN_TOOL_CALL_PLACEHOLDER.length).toBeGreaterThan(0);
	});
	it("mentions no tool output", () => {
		expect(ORPHAN_TOOL_CALL_PLACEHOLDER).toContain("No tool output");
	});
});

describe("collectKnownCallIds", () => {
	it("returns empty set for empty input", () => {
		expect(collectKnownCallIds([]).size).toBe(0);
	});
	it("collects function_call call_ids", () => {
		const result = collectKnownCallIds([{ type: "function_call", call_id: "fc_1" }] as never);
		expect(result.has("fc_1")).toBe(true);
	});
	it("collects custom_tool_call call_ids", () => {
		const result = collectKnownCallIds([{ type: "custom_tool_call", call_id: "ct_1" }] as never);
		expect(result.has("ct_1")).toBe(true);
	});
	it("ignores non-call items", () => {
		const result = collectKnownCallIds([{ type: "message" }] as never);
		expect(result.size).toBe(0);
	});
	it("collects multiple call_ids", () => {
		const result = collectKnownCallIds([
			{ type: "function_call", call_id: "fc_1" },
			{ type: "function_call", call_id: "fc_2" },
		] as never);
		expect(result.size).toBe(2);
	});
});

describe("collectCustomCallIds", () => {
	it("returns empty set for empty input", () => {
		expect(collectCustomCallIds([]).size).toBe(0);
	});
	it("collects custom_tool_call call_ids only", () => {
		const result = collectCustomCallIds([
			{ type: "function_call", call_id: "fc_1" },
			{ type: "custom_tool_call", call_id: "ct_1" },
		] as never);
		expect(result.has("ct_1")).toBe(true);
		expect(result.has("fc_1")).toBe(false);
	});
});

describe("repairOrphanResponsesToolCalls", () => {
	it("returns input unchanged when no orphans", () => {
		const input = [
			{ type: "function_call", call_id: "fc_1" },
			{ type: "function_call_output", call_id: "fc_1", output: "result" },
		] as never;
		expect(repairOrphanResponsesToolCalls(input)).toBe(input);
	});
	it("inserts placeholder output for orphan function_call", () => {
		const input = [{ type: "function_call", call_id: "fc_1" }] as never;
		const result = repairOrphanResponsesToolCalls(input);
		expect(result).toHaveLength(2);
		expect((result[1] as { type: string }).type).toBe("function_call_output");
		expect((result[1] as { output: string }).output).toBe(ORPHAN_TOOL_CALL_PLACEHOLDER);
	});
	it("inserts placeholder output for orphan custom_tool_call", () => {
		const input = [{ type: "custom_tool_call", call_id: "ct_1" }] as never;
		const result = repairOrphanResponsesToolCalls(input);
		expect(result).toHaveLength(2);
		expect((result[1] as { type: string }).type).toBe("custom_tool_call_output");
	});
	it("does not insert output when call has matching output", () => {
		const input = [
			{ type: "function_call", call_id: "fc_1" },
			{ type: "function_call_output", call_id: "fc_1", output: "result" },
		] as never;
		const result = repairOrphanResponsesToolCalls(input);
		expect(result).toHaveLength(2);
	});
	it("handles mixed orphan and non-orphan calls", () => {
		const input = [
			{ type: "function_call", call_id: "fc_1" },
			{ type: "function_call", call_id: "fc_2" },
			{ type: "function_call_output", call_id: "fc_2", output: "result" },
		] as never;
		const result = repairOrphanResponsesToolCalls(input);
		expect(result).toHaveLength(4);
	});
});

describe("createSequentialCutoffSummaryState", () => {
	it("returns state with empty summary array", () => {
		const state = createSequentialCutoffSummaryState();
		expect(state.summary).toEqual([]);
		expect(state.emitted).toBe("");
	});
});

describe("foldReasoningSummary", () => {
	it("returns empty string for undefined parts", () => {
		expect(foldReasoningSummary(undefined)).toBe("");
	});
	it("returns empty string for empty parts", () => {
		expect(foldReasoningSummary([])).toBe("");
	});
	it("returns text for single part", () => {
		expect(foldReasoningSummary([{ type: "summary_text", text: "hello" }])).toBe("hello");
	});
	it("joins non-extending parts with double newline", () => {
		expect(
			foldReasoningSummary([
				{ type: "summary_text", text: "a" },
				{ type: "summary_text", text: "b" },
			]),
		).toBe("a\n\nb");
	});
	it("extends when second part starts with first", () => {
		expect(
			foldReasoningSummary([
				{ type: "summary_text", text: "a" },
				{ type: "summary_text", text: "a\nb" },
			]),
		).toBe("a\nb");
	});
	it("skips empty text parts", () => {
		expect(
			foldReasoningSummary([
				{ type: "summary_text", text: "" },
				{ type: "summary_text", text: "a" },
			]),
		).toBe("a");
	});
	it("skips duplicate text parts", () => {
		expect(
			foldReasoningSummary([
				{ type: "summary_text", text: "a" },
				{ type: "summary_text", text: "a" },
			]),
		).toBe("a");
	});
});

describe("finalizeReasoningThinking", () => {
	it("returns summary text when available", () => {
		const item = { summary: [{ type: "summary_text", text: "summary text" }] } as never;
		expect(finalizeReasoningThinking(item, "streamed")).toBe("summary text");
	});
	it("returns content reasoning_text when no summary", () => {
		const item = { content: [{ type: "reasoning_text", text: "content text" }] } as never;
		expect(finalizeReasoningThinking(item, "streamed")).toBe("content text");
	});
	it("returns streamed thinking when no summary or content", () => {
		const item = {} as never;
		expect(finalizeReasoningThinking(item, "streamed")).toBe("streamed");
	});
	it("returns empty string when nothing available", () => {
		const item = {} as never;
		expect(finalizeReasoningThinking(item, "")).toBe("");
	});
	it("joins multiple summary parts with double newline", () => {
		const item = {
			summary: [
				{ type: "summary_text", text: "part1" },
				{ type: "summary_text", text: "part2" },
			],
		} as never;
		expect(finalizeReasoningThinking(item, "streamed")).toBe("part1\n\npart2");
	});
});
