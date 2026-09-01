import { describe, expect, it } from "bun:test";
import {
	buildToolBatchLedger,
	renderToolBatchLedger,
	TOOL_BATCH_LEDGER_HEADLINE_PREFIX,
	TOOL_BATCH_LEDGER_MAX_ENTRIES,
	TOOL_BATCH_LEDGER_MAX_FIELD_WIDTH,
} from "../src/tool-batch-ledger";
import { capToolResultContent, DEFAULT_TOOL_RESULT_MAX_BYTES } from "../src/tool-result-cap";

describe("TOOL_BATCH_LEDGER_MAX_ENTRIES", () => {
	it("is 24", () => {
		expect(TOOL_BATCH_LEDGER_MAX_ENTRIES).toBe(24);
	});
});

describe("TOOL_BATCH_LEDGER_MAX_FIELD_WIDTH", () => {
	it("is 48", () => {
		expect(TOOL_BATCH_LEDGER_MAX_FIELD_WIDTH).toBe(48);
	});
});

describe("buildToolBatchLedger", () => {
	it("counts completed calls", () => {
		const ledger = buildToolBatchLedger("stream_error", [
			{ toolCallId: "1", toolName: "foo", outcome: "ok" },
			{ toolCallId: "2", toolName: "bar", outcome: "ok" },
		]);
		expect(ledger.completed).toBe(2);
		expect(ledger.interrupted).toBe(0);
		expect(ledger.dropped).toBe(0);
		expect(ledger.omitted).toBe(0);
	});
	it("counts interrupted calls", () => {
		const ledger = buildToolBatchLedger("interrupted", [
			{ toolCallId: "1", toolName: "foo", outcome: "interrupted" },
		]);
		expect(ledger.interrupted).toBe(1);
		expect(ledger.completed).toBe(0);
	});
	it("counts dropped calls", () => {
		const ledger = buildToolBatchLedger("aborted", [{ toolCallId: "1", toolName: "foo", outcome: "dropped" }]);
		expect(ledger.dropped).toBe(1);
	});
	it("counts mixed outcomes", () => {
		const ledger = buildToolBatchLedger("stream_error", [
			{ toolCallId: "1", toolName: "foo", outcome: "ok" },
			{ toolCallId: "2", toolName: "bar", outcome: "interrupted" },
			{ toolCallId: "3", toolName: "baz", outcome: "dropped" },
			{ toolCallId: "4", toolName: "qux", outcome: "failed" },
		]);
		expect(ledger.completed).toBe(2);
		expect(ledger.interrupted).toBe(1);
		expect(ledger.dropped).toBe(1);
	});
	it("truncates long tool call IDs", () => {
		const longId = "a".repeat(100);
		const ledger = buildToolBatchLedger("stream_error", [{ toolCallId: longId, toolName: "foo", outcome: "ok" }]);
		expect(ledger.entries[0]!.toolCallId.length).toBeLessThan(100);
	});
	it("truncates long tool names", () => {
		const longName = "b".repeat(100);
		const ledger = buildToolBatchLedger("stream_error", [{ toolCallId: "1", toolName: longName, outcome: "ok" }]);
		expect(ledger.entries[0]!.toolName.length).toBeLessThan(100);
	});
	it("limits entries to max", () => {
		const calls = Array.from({ length: 30 }, (_, i) => ({
			toolCallId: `call_${i}`,
			toolName: `tool_${i}`,
			outcome: "ok" as const,
		}));
		const ledger = buildToolBatchLedger("stream_error", calls);
		expect(ledger.entries.length).toBe(TOOL_BATCH_LEDGER_MAX_ENTRIES);
		expect(ledger.omitted).toBe(30 - TOOL_BATCH_LEDGER_MAX_ENTRIES);
	});
	it("preserves argumentsIncomplete flag", () => {
		const ledger = buildToolBatchLedger("stream_error", [
			{ toolCallId: "1", toolName: "foo", outcome: "dropped", argumentsIncomplete: true },
		]);
		expect(ledger.entries[0]!.argumentsIncomplete).toBe(true);
	});
	it("omits argumentsIncomplete when false", () => {
		const ledger = buildToolBatchLedger("stream_error", [
			{ toolCallId: "1", toolName: "foo", outcome: "ok", argumentsIncomplete: false },
		]);
		expect(ledger.entries[0]!.argumentsIncomplete).toBeUndefined();
	});
	it("handles empty calls", () => {
		const ledger = buildToolBatchLedger("stream_error", []);
		expect(ledger.completed).toBe(0);
		expect(ledger.entries).toEqual([]);
		expect(ledger.omitted).toBe(0);
	});
});

describe("renderToolBatchLedger", () => {
	it("renders headline with total calls", () => {
		const ledger = buildToolBatchLedger("stream_error", [{ toolCallId: "1", toolName: "foo", outcome: "ok" }]);
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain(TOOL_BATCH_LEDGER_HEADLINE_PREFIX);
		expect(rendered).toContain("1 call");
	});
	it("uses plural 'calls' for multiple", () => {
		const ledger = buildToolBatchLedger("stream_error", [
			{ toolCallId: "1", toolName: "foo", outcome: "ok" },
			{ toolCallId: "2", toolName: "bar", outcome: "ok" },
		]);
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("2 calls");
	});
	it("includes cause line for stream_error", () => {
		const ledger = buildToolBatchLedger("stream_error", []);
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("transport failure");
	});
	it("includes cause line for aborted", () => {
		const ledger = buildToolBatchLedger("aborted", []);
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("aborted");
	});
	it("includes cause line for interrupted", () => {
		const ledger = buildToolBatchLedger("interrupted", []);
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("interrupted");
	});
	it("lists entries with outcome labels", () => {
		const ledger = buildToolBatchLedger("stream_error", [
			{ toolCallId: "call_1", toolName: "getWeather", outcome: "ok" },
		]);
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("call_1");
		expect(rendered).toContain("getWeather");
		expect(rendered).toContain("ran, ok");
	});
	it("shows failed outcome label", () => {
		const ledger = buildToolBatchLedger("stream_error", [{ toolCallId: "1", toolName: "foo", outcome: "failed" }]);
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("ran, failed");
	});
	it("shows interrupted outcome label", () => {
		const ledger = buildToolBatchLedger("stream_error", [
			{ toolCallId: "1", toolName: "foo", outcome: "interrupted" },
		]);
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("started, no result recorded");
	});
	it("shows dropped outcome label", () => {
		const ledger = buildToolBatchLedger("stream_error", [{ toolCallId: "1", toolName: "foo", outcome: "dropped" }]);
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("never ran");
	});
	it("shows arguments never finished for incomplete args", () => {
		const ledger = buildToolBatchLedger("stream_error", [
			{ toolCallId: "1", toolName: "foo", outcome: "dropped", argumentsIncomplete: true },
		]);
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("arguments never finished");
	});
	it("shows omitted count when entries are truncated", () => {
		const calls = Array.from({ length: 30 }, (_, i) => ({
			toolCallId: `call_${i}`,
			toolName: `tool_${i}`,
			outcome: "ok" as const,
		}));
		const ledger = buildToolBatchLedger("stream_error", calls);
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("more call");
	});
	it("includes retry guidance for completed calls", () => {
		const ledger = buildToolBatchLedger("stream_error", [{ toolCallId: "1", toolName: "foo", outcome: "ok" }]);
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("Do not re-run them");
	});
	it("includes retry guidance for interrupted calls", () => {
		const ledger = buildToolBatchLedger("stream_error", [
			{ toolCallId: "1", toolName: "foo", outcome: "interrupted" },
		]);
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("Check state before retrying");
	});
	it("includes retry guidance for dropped calls", () => {
		const ledger = buildToolBatchLedger("stream_error", [{ toolCallId: "1", toolName: "foo", outcome: "dropped" }]);
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("need retrying");
	});
});

describe("DEFAULT_TOOL_RESULT_MAX_BYTES", () => {
	it("is 1 MiB", () => {
		expect(DEFAULT_TOOL_RESULT_MAX_BYTES).toBe(1024 * 1024);
	});
});

describe("capToolResultContent", () => {
	it("returns content unchanged when under limit", () => {
		const content = [{ type: "text" as const, text: "hello" }];
		const result = capToolResultContent(content, "test", 1000);
		expect(result.content).toBe(content);
		expect(result.elidedBytes).toBe(0);
		expect(result.originalBytes).toBe(5);
	});
	it("returns content unchanged when maxBytes is 0", () => {
		const content = [{ type: "text" as const, text: "hello" }];
		const result = capToolResultContent(content, "test", 0);
		expect(result.content).toBe(content);
	});
	it("caps text content over limit", () => {
		const longText = "a".repeat(2000);
		const content = [{ type: "text" as const, text: longText }];
		const result = capToolResultContent(content, "test", 100);
		expect(result.elidedBytes).toBeGreaterThan(0);
		expect(result.content[0]!.type).toBe("text");
		const text = (result.content[0] as { text: string }).text;
		expect(text.length).toBeLessThan(longText.length);
	});
	it("preserves image content blocks", () => {
		const content = [{ type: "image" as const, mimeType: "image/png", data: "base64data" }];
		const result = capToolResultContent(content, "test", 100);
		expect(result.content[0]).toEqual(content[0]);
	});
	it("handles mixed text and image content", () => {
		const content = [
			{ type: "text" as const, text: "a".repeat(2000) },
			{ type: "image" as const, mimeType: "image/png", data: "base64data" },
		];
		const result = capToolResultContent(content, "test", 100);
		expect(result.content.length).toBe(2);
		expect(result.content[1]!.type).toBe("image");
	});
	it("handles empty content", () => {
		const result = capToolResultContent([], "test", 100);
		expect(result.content).toEqual([]);
		expect(result.originalBytes).toBe(0);
		expect(result.elidedBytes).toBe(0);
	});
	it("handles multiple text blocks proportionally", () => {
		const content = [
			{ type: "text" as const, text: "a".repeat(800) },
			{ type: "text" as const, text: "b".repeat(200) },
		];
		const result = capToolResultContent(content, "test", 500);
		expect(result.elidedBytes).toBeGreaterThan(0);
	});
});
