import { describe, expect, it } from "bun:test";
import {
	buildToolBatchLedger,
	renderToolBatchLedger,
	TOOL_BATCH_LEDGER_HEADLINE_PREFIX,
	TOOL_BATCH_LEDGER_MAX_ENTRIES,
	TOOL_BATCH_LEDGER_MAX_FIELD_WIDTH,
	type ToolBatchCallEntry,
} from "../src/tool-batch-ledger";

function makeCall(overrides: Partial<ToolBatchCallEntry> & { toolCallId: string }): ToolBatchCallEntry {
	return { toolName: "test-tool", outcome: "ok", ...overrides };
}

describe("TOOL_BATCH_LEDGER constants", () => {
	it("MAX_ENTRIES is 24", () => {
		expect(TOOL_BATCH_LEDGER_MAX_ENTRIES).toBe(24);
	});
	it("MAX_FIELD_WIDTH is 48", () => {
		expect(TOOL_BATCH_LEDGER_MAX_FIELD_WIDTH).toBe(48);
	});
	it("HEADLINE_PREFIX is correct", () => {
		expect(TOOL_BATCH_LEDGER_HEADLINE_PREFIX).toContain("Partial completion ledger");
	});
});

describe("buildToolBatchLedger", () => {
	it("counts completed calls", () => {
		const ledger = buildToolBatchLedger("stream_error", [
			makeCall({ toolCallId: "1", outcome: "ok" }),
			makeCall({ toolCallId: "2", outcome: "failed" }),
		]);
		expect(ledger.completed).toBe(2);
		expect(ledger.interrupted).toBe(0);
		expect(ledger.dropped).toBe(0);
	});
	it("counts interrupted calls", () => {
		const ledger = buildToolBatchLedger("interrupted", [makeCall({ toolCallId: "1", outcome: "interrupted" })]);
		expect(ledger.interrupted).toBe(1);
		expect(ledger.completed).toBe(0);
	});
	it("counts dropped calls", () => {
		const ledger = buildToolBatchLedger("aborted", [makeCall({ toolCallId: "1", outcome: "dropped" })]);
		expect(ledger.dropped).toBe(1);
	});
	it("mixes outcomes", () => {
		const ledger = buildToolBatchLedger("stream_error", [
			makeCall({ toolCallId: "1", outcome: "ok" }),
			makeCall({ toolCallId: "2", outcome: "interrupted" }),
			makeCall({ toolCallId: "3", outcome: "dropped" }),
			makeCall({ toolCallId: "4", outcome: "failed" }),
		]);
		expect(ledger.completed).toBe(2);
		expect(ledger.interrupted).toBe(1);
		expect(ledger.dropped).toBe(1);
	});
	it("truncates entries to max", () => {
		const calls = Array.from({ length: 30 }, (_, i) => makeCall({ toolCallId: `call-${i}`, outcome: "ok" }));
		const ledger = buildToolBatchLedger("stream_error", calls);
		expect(ledger.entries).toHaveLength(24);
		expect(ledger.omitted).toBe(6);
	});
	it("handles empty calls", () => {
		const ledger = buildToolBatchLedger("stream_error", []);
		expect(ledger.completed).toBe(0);
		expect(ledger.entries).toEqual([]);
		expect(ledger.omitted).toBe(0);
	});
	it("preserves argumentsIncomplete flag", () => {
		const ledger = buildToolBatchLedger("stream_error", [
			makeCall({ toolCallId: "1", outcome: "dropped", argumentsIncomplete: true }),
		]);
		expect(ledger.entries[0].argumentsIncomplete).toBe(true);
	});
	it("does not set argumentsIncomplete when false", () => {
		const ledger = buildToolBatchLedger("stream_error", [
			makeCall({ toolCallId: "1", outcome: "ok", argumentsIncomplete: false }),
		]);
		expect(ledger.entries[0].argumentsIncomplete).toBeUndefined();
	});
	it("truncates long tool names", () => {
		const longName = "x".repeat(100);
		const ledger = buildToolBatchLedger("stream_error", [
			makeCall({ toolCallId: "1", toolName: longName, outcome: "ok" }),
		]);
		expect(ledger.entries[0].toolName.length).toBeLessThan(longName.length);
	});
});

describe("renderToolBatchLedger", () => {
	it("renders headline with total", () => {
		const ledger = buildToolBatchLedger("stream_error", [
			makeCall({ toolCallId: "1", outcome: "ok" }),
			makeCall({ toolCallId: "2", outcome: "dropped" }),
		]);
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("2 calls");
		expect(rendered).toContain("1 ran");
		expect(rendered).toContain("1 never ran");
	});
	it("uses singular 'call' for one total", () => {
		const ledger = buildToolBatchLedger("stream_error", [makeCall({ toolCallId: "1", outcome: "ok" })]);
		expect(renderToolBatchLedger(ledger)).toContain("1 call");
	});
	it("includes cause line", () => {
		const ledger = buildToolBatchLedger("aborted", [makeCall({ toolCallId: "1", outcome: "dropped" })]);
		expect(renderToolBatchLedger(ledger)).toContain("aborted");
	});
	it("includes entry lines", () => {
		const ledger = buildToolBatchLedger("stream_error", [
			makeCall({ toolCallId: "call-1", toolName: "my-tool", outcome: "ok" }),
		]);
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("call-1");
		expect(rendered).toContain("my-tool");
		expect(rendered).toContain("ran, ok");
	});
	it("includes omitted count", () => {
		const calls = Array.from({ length: 30 }, (_, i) => makeCall({ toolCallId: `call-${i}`, outcome: "ok" }));
		const ledger = buildToolBatchLedger("stream_error", calls);
		expect(renderToolBatchLedger(ledger)).toContain("6 more");
	});
	it("includes retry guidance for dropped", () => {
		const ledger = buildToolBatchLedger("stream_error", [makeCall({ toolCallId: "1", outcome: "dropped" })]);
		expect(renderToolBatchLedger(ledger)).toContain("never ran");
	});
	it("includes interrupted guidance", () => {
		const ledger = buildToolBatchLedger("stream_error", [makeCall({ toolCallId: "1", outcome: "interrupted" })]);
		expect(renderToolBatchLedger(ledger)).toContain("partial side effects");
	});
	it("includes completed guidance", () => {
		const ledger = buildToolBatchLedger("stream_error", [makeCall({ toolCallId: "1", outcome: "ok" })]);
		expect(renderToolBatchLedger(ledger)).toContain("Do not re-run");
	});
	it("includes argumentsIncomplete guidance", () => {
		const ledger = buildToolBatchLedger("stream_error", [
			makeCall({ toolCallId: "1", outcome: "dropped", argumentsIncomplete: true }),
		]);
		expect(renderToolBatchLedger(ledger)).toContain("arguments never finished");
	});
	it("uses singular 'more call' for one omitted", () => {
		const calls = Array.from({ length: 25 }, (_, i) => makeCall({ toolCallId: `call-${i}`, outcome: "ok" }));
		const ledger = buildToolBatchLedger("stream_error", calls);
		expect(renderToolBatchLedger(ledger)).toContain("1 more call not listed");
	});
});
