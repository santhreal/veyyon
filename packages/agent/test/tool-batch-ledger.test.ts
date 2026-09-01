import { describe, expect, it } from "bun:test";
import {
	buildToolBatchLedger,
	renderToolBatchLedger,
	TOOL_BATCH_LEDGER_HEADLINE_PREFIX,
	TOOL_BATCH_LEDGER_MAX_ENTRIES,
	TOOL_BATCH_LEDGER_MAX_FIELD_WIDTH,
	type ToolBatchCallEntry,
	type ToolBatchLedger,
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

describe("buildToolBatchLedger", () => {
	it("builds ledger with all completed calls", () => {
		const calls: ToolBatchCallEntry[] = [
			{ toolCallId: "call_1", toolName: "bash", outcome: "ok" },
			{ toolCallId: "call_2", toolName: "read", outcome: "ok" },
		];
		const ledger = buildToolBatchLedger("stream_error", calls);
		expect(ledger.cause).toBe("stream_error");
		expect(ledger.completed).toBe(2);
		expect(ledger.interrupted).toBe(0);
		expect(ledger.dropped).toBe(0);
		expect(ledger.omitted).toBe(0);
		expect(ledger.entries).toHaveLength(2);
	});

	it("counts interrupted calls", () => {
		const calls: ToolBatchCallEntry[] = [
			{ toolCallId: "call_1", toolName: "bash", outcome: "ok" },
			{ toolCallId: "call_2", toolName: "bash", outcome: "interrupted" },
		];
		const ledger = buildToolBatchLedger("interrupted", calls);
		expect(ledger.completed).toBe(1);
		expect(ledger.interrupted).toBe(1);
	});

	it("counts dropped calls", () => {
		const calls: ToolBatchCallEntry[] = [
			{ toolCallId: "call_1", toolName: "bash", outcome: "ok" },
			{ toolCallId: "call_2", toolName: "bash", outcome: "dropped" },
			{ toolCallId: "call_3", toolName: "bash", outcome: "dropped" },
		];
		const ledger = buildToolBatchLedger("aborted", calls);
		expect(ledger.completed).toBe(1);
		expect(ledger.dropped).toBe(2);
	});

	it("counts failed calls as completed", () => {
		const calls: ToolBatchCallEntry[] = [{ toolCallId: "call_1", toolName: "bash", outcome: "failed" }];
		const ledger = buildToolBatchLedger("stream_error", calls);
		expect(ledger.completed).toBe(1);
	});

	it("truncates long tool call IDs", () => {
		const longId = "a".repeat(100);
		const calls: ToolBatchCallEntry[] = [{ toolCallId: longId, toolName: "bash", outcome: "ok" }];
		const ledger = buildToolBatchLedger("stream_error", calls);
		expect(ledger.entries[0]!.toolCallId.length).toBeLessThanOrEqual(48);
	});

	it("truncates long tool names", () => {
		const longName = "t".repeat(100);
		const calls: ToolBatchCallEntry[] = [{ toolCallId: "call_1", toolName: longName, outcome: "ok" }];
		const ledger = buildToolBatchLedger("stream_error", calls);
		expect(ledger.entries[0]!.toolName.length).toBeLessThanOrEqual(48);
	});

	it("preserves argumentsIncomplete flag", () => {
		const calls: ToolBatchCallEntry[] = [
			{ toolCallId: "call_1", toolName: "bash", outcome: "dropped", argumentsIncomplete: true },
		];
		const ledger = buildToolBatchLedger("stream_error", calls);
		expect(ledger.entries[0]!.argumentsIncomplete).toBe(true);
	});

	it("does not set argumentsIncomplete when false", () => {
		const calls: ToolBatchCallEntry[] = [
			{ toolCallId: "call_1", toolName: "bash", outcome: "ok", argumentsIncomplete: false },
		];
		const ledger = buildToolBatchLedger("stream_error", calls);
		expect(ledger.entries[0]!.argumentsIncomplete).toBeUndefined();
	});

	it("caps entries at max", () => {
		const calls: ToolBatchCallEntry[] = Array.from({ length: 30 }, (_, i) => ({
			toolCallId: `call_${i}`,
			toolName: "bash",
			outcome: "ok" as const,
		}));
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
		expect(rendered).toContain(TOOL_BATCH_LEDGER_HEADLINE_PREFIX);
		expect(rendered).toContain("3 calls");
		expect(rendered).toContain("2 ran");
		expect(rendered).toContain("1 never ran");
	});

	it("uses singular for one call", () => {
		const ledger: ToolBatchLedger = {
			cause: "aborted",
			entries: [],
			completed: 1,
			interrupted: 0,
			dropped: 0,
			omitted: 0,
		};
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("1 call");
		expect(rendered).not.toContain("1 calls");
	});

	it("includes cause line", () => {
		const ledger: ToolBatchLedger = {
			cause: "aborted",
			entries: [],
			completed: 0,
			interrupted: 0,
			dropped: 1,
			omitted: 0,
		};
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("Cause:");
		expect(rendered).toContain("aborted");
	});

	it("includes interrupted count when present", () => {
		const ledger: ToolBatchLedger = {
			cause: "interrupted",
			entries: [],
			completed: 1,
			interrupted: 2,
			dropped: 0,
			omitted: 0,
		};
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("2 interrupted");
	});

	it("lists entry details", () => {
		const ledger: ToolBatchLedger = {
			cause: "stream_error",
			entries: [
				{ toolCallId: "call_1", toolName: "bash", outcome: "ok" },
				{ toolCallId: "call_2", toolName: "read", outcome: "dropped" },
			],
			completed: 1,
			interrupted: 0,
			dropped: 1,
			omitted: 0,
		};
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("call_1");
		expect(rendered).toContain("call_2");
		expect(rendered).toContain("bash");
		expect(rendered).toContain("read");
	});

	it("includes omitted count when entries are truncated", () => {
		const ledger: ToolBatchLedger = {
			cause: "stream_error",
			entries: [],
			completed: 0,
			interrupted: 0,
			dropped: 0,
			omitted: 5,
		};
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("+5 more calls");
	});

	it("uses singular for one omitted call", () => {
		const ledger: ToolBatchLedger = {
			cause: "stream_error",
			entries: [],
			completed: 0,
			interrupted: 0,
			dropped: 0,
			omitted: 1,
		};
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("+1 more call");
		expect(rendered).not.toContain("+1 more calls");
	});

	it("includes retry guidance for completed calls", () => {
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
			cause: "interrupted",
			entries: [],
			completed: 0,
			interrupted: 1,
			dropped: 0,
			omitted: 0,
		};
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("partial side effects");
	});

	it("includes retry guidance for dropped calls", () => {
		const ledger: ToolBatchLedger = {
			cause: "aborted",
			entries: [],
			completed: 0,
			interrupted: 0,
			dropped: 1,
			omitted: 0,
		};
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("need retrying");
	});

	it("includes arguments-incomplete guidance when present", () => {
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

	it("uses special label for argumentsIncomplete entries", () => {
		const ledger: ToolBatchLedger = {
			cause: "stream_error",
			entries: [{ toolCallId: "call_1", toolName: "bash", outcome: "dropped", argumentsIncomplete: true }],
			completed: 0,
			interrupted: 0,
			dropped: 1,
			omitted: 0,
		};
		const rendered = renderToolBatchLedger(ledger);
		expect(rendered).toContain("never ran, arguments never finished");
	});
});
