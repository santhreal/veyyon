import { describe, expect, it } from "bun:test";
import type { ToolBatchCallEntry, ToolBatchLedger } from "../src/tool-batch-ledger";
import {
	buildToolBatchLedger,
	renderToolBatchLedger,
	TOOL_BATCH_LEDGER_HEADLINE_PREFIX,
	TOOL_BATCH_LEDGER_MAX_ENTRIES,
	TOOL_BATCH_LEDGER_MAX_FIELD_WIDTH,
} from "../src/tool-batch-ledger";

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

describe("TOOL_BATCH_LEDGER_HEADLINE_PREFIX", () => {
	it("starts with 'Partial completion ledger'", () => {
		expect(TOOL_BATCH_LEDGER_HEADLINE_PREFIX).toContain("Partial completion ledger");
	});
	it("ends with opening paren", () => {
		expect(TOOL_BATCH_LEDGER_HEADLINE_PREFIX.endsWith("(")).toBe(true);
	});
});

describe("buildToolBatchLedger", () => {
	it("counts completed calls", () => {
		const calls: ToolBatchCallEntry[] = [
			{ toolCallId: "1", toolName: "foo", outcome: "ok" },
			{ toolCallId: "2", toolName: "bar", outcome: "ok" },
		];
		const ledger = buildToolBatchLedger("stream_error", calls);
		expect(ledger.completed).toBe(2);
		expect(ledger.interrupted).toBe(0);
		expect(ledger.dropped).toBe(0);
	});
	it("counts interrupted calls", () => {
		const calls: ToolBatchCallEntry[] = [{ toolCallId: "1", toolName: "foo", outcome: "interrupted" }];
		const ledger = buildToolBatchLedger("interrupted", calls);
		expect(ledger.interrupted).toBe(1);
		expect(ledger.completed).toBe(0);
	});
	it("counts dropped calls", () => {
		const calls: ToolBatchCallEntry[] = [{ toolCallId: "1", toolName: "foo", outcome: "dropped" }];
		const ledger = buildToolBatchLedger("aborted", calls);
		expect(ledger.dropped).toBe(1);
	});
	it("counts failed as completed", () => {
		const calls: ToolBatchCallEntry[] = [{ toolCallId: "1", toolName: "foo", outcome: "failed" }];
		const ledger = buildToolBatchLedger("stream_error", calls);
		expect(ledger.completed).toBe(1);
	});
	it("preserves entry order", () => {
		const calls: ToolBatchCallEntry[] = [
			{ toolCallId: "a", toolName: "foo", outcome: "ok" },
			{ toolCallId: "b", toolName: "bar", outcome: "dropped" },
		];
		const ledger = buildToolBatchLedger("stream_error", calls);
		expect(ledger.entries[0].toolCallId).toBe("a");
		expect(ledger.entries[1].toolCallId).toBe("b");
	});
	it("truncates long tool call ids", () => {
		const longId = "x".repeat(100);
		const calls: ToolBatchCallEntry[] = [{ toolCallId: longId, toolName: "foo", outcome: "ok" }];
		const ledger = buildToolBatchLedger("stream_error", calls);
		expect(ledger.entries[0].toolCallId.length).toBeLessThanOrEqual(TOOL_BATCH_LEDGER_MAX_FIELD_WIDTH);
	});
	it("truncates long tool names", () => {
		const longName = "x".repeat(100);
		const calls: ToolBatchCallEntry[] = [{ toolCallId: "1", toolName: longName, outcome: "ok" }];
		const ledger = buildToolBatchLedger("stream_error", calls);
		expect(ledger.entries[0].toolName.length).toBeLessThanOrEqual(TOOL_BATCH_LEDGER_MAX_FIELD_WIDTH);
	});
	it("caps entries at max", () => {
		const calls: ToolBatchCallEntry[] = Array.from({ length: 30 }, (_, i) => ({
			toolCallId: String(i),
			toolName: "foo",
			outcome: "ok" as const,
		}));
		const ledger = buildToolBatchLedger("stream_error", calls);
		expect(ledger.entries.length).toBe(TOOL_BATCH_LEDGER_MAX_ENTRIES);
		expect(ledger.omitted).toBe(30 - TOOL_BATCH_LEDGER_MAX_ENTRIES);
	});
	it("sets omitted to 0 when under max", () => {
		const calls: ToolBatchCallEntry[] = [{ toolCallId: "1", toolName: "foo", outcome: "ok" }];
		const ledger = buildToolBatchLedger("stream_error", calls);
		expect(ledger.omitted).toBe(0);
	});
	it("passes through argumentsIncomplete flag", () => {
		const calls: ToolBatchCallEntry[] = [
			{ toolCallId: "1", toolName: "foo", outcome: "dropped", argumentsIncomplete: true },
		];
		const ledger = buildToolBatchLedger("stream_error", calls);
		expect(ledger.entries[0].argumentsIncomplete).toBe(true);
	});
	it("omits argumentsIncomplete when not set", () => {
		const calls: ToolBatchCallEntry[] = [{ toolCallId: "1", toolName: "foo", outcome: "ok" }];
		const ledger = buildToolBatchLedger("stream_error", calls);
		expect(ledger.entries[0].argumentsIncomplete).toBeUndefined();
	});
	it("handles empty calls", () => {
		const ledger = buildToolBatchLedger("stream_error", []);
		expect(ledger.completed).toBe(0);
		expect(ledger.entries).toEqual([]);
		expect(ledger.omitted).toBe(0);
	});
});

describe("renderToolBatchLedger", () => {
	it("renders headline with total count", () => {
		const ledger: ToolBatchLedger = {
			cause: "stream_error",
			entries: [],
			completed: 2,
			interrupted: 0,
			dropped: 1,
			omitted: 0,
		};
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("3 calls");
		expect(rendered).toContain("2 ran");
		expect(rendered).toContain("1 never ran");
	});
	it("uses singular 'call' for single total", () => {
		const ledger: ToolBatchLedger = {
			cause: "stream_error",
			entries: [],
			completed: 1,
			interrupted: 0,
			dropped: 0,
			omitted: 0,
		};
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("1 call)");
		expect(rendered).not.toContain("1 calls)");
	});
	it("includes cause line for stream_error", () => {
		const ledger: ToolBatchLedger = {
			cause: "stream_error",
			entries: [],
			completed: 0,
			interrupted: 0,
			dropped: 1,
			omitted: 0,
		};
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("transport failure");
	});
	it("includes cause line for aborted", () => {
		const ledger: ToolBatchLedger = {
			cause: "aborted",
			entries: [],
			completed: 0,
			interrupted: 0,
			dropped: 1,
			omitted: 0,
		};
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("turn was aborted");
	});
	it("includes cause line for interrupted", () => {
		const ledger: ToolBatchLedger = {
			cause: "interrupted",
			entries: [],
			completed: 0,
			interrupted: 0,
			dropped: 1,
			omitted: 0,
		};
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("batch was interrupted");
	});
	it("lists entry with outcome label", () => {
		const ledger: ToolBatchLedger = {
			cause: "stream_error",
			entries: [{ toolCallId: "call_1", toolName: "bash", outcome: "ok" }],
			completed: 1,
			interrupted: 0,
			dropped: 0,
			omitted: 0,
		};
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("call_1");
		expect(rendered).toContain("bash");
		expect(rendered).toContain("ran, ok");
	});
	it("shows arguments never finished for incomplete entries", () => {
		const ledger: ToolBatchLedger = {
			cause: "stream_error",
			entries: [{ toolCallId: "call_1", toolName: "bash", outcome: "dropped", argumentsIncomplete: true }],
			completed: 0,
			interrupted: 0,
			dropped: 1,
			omitted: 0,
		};
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("arguments never finished");
	});
	it("includes omitted count when entries are truncated", () => {
		const ledger: ToolBatchLedger = {
			cause: "stream_error",
			entries: [],
			completed: 0,
			interrupted: 0,
			dropped: 25,
			omitted: 25,
		};
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("+25 more calls not listed");
	});
	it("uses singular 'call' for single omitted", () => {
		const ledger: ToolBatchLedger = {
			cause: "stream_error",
			entries: [],
			completed: 0,
			interrupted: 0,
			dropped: 1,
			omitted: 1,
		};
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("+1 more call not listed");
	});
	it("includes retry advice for completed calls", () => {
		const ledger: ToolBatchLedger = {
			cause: "stream_error",
			entries: [],
			completed: 1,
			interrupted: 0,
			dropped: 0,
			omitted: 0,
		};
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("Do not re-run them");
	});
	it("includes partial effects warning for interrupted calls", () => {
		const ledger: ToolBatchLedger = {
			cause: "stream_error",
			entries: [],
			completed: 0,
			interrupted: 1,
			dropped: 0,
			omitted: 0,
		};
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("partial side effects");
	});
	it("includes retry advice for dropped calls", () => {
		const ledger: ToolBatchLedger = {
			cause: "stream_error",
			entries: [],
			completed: 0,
			interrupted: 0,
			dropped: 1,
			omitted: 0,
		};
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("need retrying");
	});
	it("includes reconstruction advice for argumentsIncomplete", () => {
		const ledger: ToolBatchLedger = {
			cause: "stream_error",
			entries: [{ toolCallId: "1", toolName: "foo", outcome: "dropped", argumentsIncomplete: true }],
			completed: 0,
			interrupted: 0,
			dropped: 1,
			omitted: 0,
		};
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("Reconstruct their arguments");
	});
});
