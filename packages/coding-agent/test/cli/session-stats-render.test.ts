import { describe, expect, it } from "bun:test";
import type { SessionStatsReport, SessionStatsTotals, TurnStat } from "../../src/cli/session-stats";
import { formatSessionStats } from "../../src/cli/session-stats-render";

/**
 * formatSessionStats renders `veyyon session stats` as aligned text. It had no
 * test even though it owns several load-bearing decisions that a regression could
 * silently break:
 *   - the tool-calls line pluralizes errors ("1 error" vs "2 errors"), omits the
 *     error clause at zero, and appends "· N instrumented" ONLY when some calls
 *     were not instrumented;
 *   - empty sections (tool latency, tool cost, repeated calls, per-turn) print no
 *     header at all;
 *   - long tables are capped, and the cap is surfaced with an explicit note, never
 *     a silent truncation (Law 10): repeated calls over 25 show "… N more", and
 *     turns over 40 show the 40 SLOWEST by request time, restored to session order,
 *     under a "40 slowest of N" note;
 *   - a missing session id reads "(unknown)".
 * These are pinned on real rendered strings so any layout or wording change is a
 * visible diff.
 */

const TOTALS: SessionStatsTotals = {
	assistantTurns: 2,
	userMessages: 1,
	toolCalls: 5,
	instrumentedToolCalls: 3,
	toolErrors: 1,
	input: 100,
	output: 50,
	cacheRead: 10,
	cacheWrite: 5,
	totalTokens: 150,
	requestMs: 1200,
	toolDurationMs: 800,
	queueWaitMs: 100,
	resultTokens: 40,
	resultBytes: 2048,
	wallClockMs: 3000,
};

function report(overrides: Partial<SessionStatsReport> = {}): SessionStatsReport {
	return {
		sessionId: "abc",
		cwd: "/tmp/x",
		messages: 3,
		instrumentationLevel: "rich",
		totals: TOTALS,
		turns: [],
		toolLatency: [],
		toolCost: [],
		repeatedCalls: [],
		...overrides,
	};
}

function turn(index: number, requestMs: number): TurnStat {
	return {
		index,
		model: "m",
		timestamp: 0,
		requestMs,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		toolCalls: 0,
	};
}

function line(text: string, needle: string): string | undefined {
	return text.split("\n").find(l => l.includes(needle));
}

describe("formatSessionStats totals line", () => {
	it("pluralizes a single tool error and notes partial instrumentation", () => {
		expect(line(formatSessionStats(report()), "tool calls")).toBe("  tool calls     5 (1 error) · 3 instrumented");
	});

	it("pluralizes multiple errors and omits the instrumented note when all calls are instrumented", () => {
		const r = report({ totals: { ...TOTALS, toolErrors: 2, instrumentedToolCalls: 5 } });
		expect(line(formatSessionStats(r), "tool calls")).toBe("  tool calls     5 (2 errors)");
	});

	it("omits the error clause entirely at zero errors", () => {
		const r = report({ totals: { ...TOTALS, toolErrors: 0, instrumentedToolCalls: 5 } });
		expect(line(formatSessionStats(r), "tool calls")).toBe("  tool calls     5");
	});

	it("renders durations, byte sizes and the header the same way each run", () => {
		const text = formatSessionStats(report());
		expect(line(text, "wall clock")).toBe("  wall clock     3.0s");
		expect(line(text, "result weight")).toBe("  result weight  40 tokens, 2.0KB");
		expect(text.startsWith("Session abc")).toBe(true);
	});

	it("renders the remaining totals lines (turns, instrumentation, tokens, tool time, queue wait)", () => {
		// These lines share the same aligned-label renderer as the ones above; pinning them
		// keeps a label-width or wording change from slipping through as an invisible diff.
		const text = formatSessionStats(report());
		expect(line(text, "2 assistant")).toBe("  turns          2 assistant, 1 user");
		expect(line(text, "instrumentation")).toBe("  instrumentation rich");
		expect(line(text, "total (in")).toBe("  tokens         150 total (in 100, out 50, cacheR 10, cacheW 5)");
		expect(line(text, "tool time")).toBe("  tool time      800ms");
		expect(line(text, "queue wait")).toBe("  queue wait     100ms");
	});

	it("labels a missing session id as (unknown)", () => {
		expect(formatSessionStats(report({ sessionId: "" })).startsWith("Session (unknown)")).toBe(true);
	});
});

describe("formatSessionStats section suppression", () => {
	it("prints no section headers when every table is empty", () => {
		const text = formatSessionStats(report());
		expect(text).not.toContain("Tool latency");
		expect(text).not.toContain("Tool cost");
		expect(text).not.toContain("Repeated identical calls");
		expect(text).not.toContain("Per-turn");
	});
});

describe("formatSessionStats populated tables", () => {
	// The edge-case tests above render with empty tables; these pin the actual row
	// rendering for each populated section (latency percentiles, per-turn cost, and the
	// repeated-call fingerprint) so a column reorder or format change is a visible diff.
	const populated = report({
		toolLatency: [
			{
				tool: "read",
				calls: 4,
				timed: 3,
				totalDurationMs: 600,
				p50DurationMs: 200,
				p95DurationMs: 300,
				maxDurationMs: 300,
				queueWaitMs: 35,
				errors: 0,
			},
		],
		turns: [
			{
				index: 1,
				model: "anthropic/claude",
				timestamp: 1100,
				requestMs: 300,
				input: 100,
				output: 20,
				cacheRead: 50,
				cacheWrite: 10,
				totalTokens: 180,
				toolCalls: 2,
			},
		],
		repeatedCalls: [{ tool: "read", argsHash: "aaaa1111", count: 2, totalDurationMs: 300, totalResultTokens: 40 }],
	});
	const text = formatSessionStats(populated);
	const lines = text.split("\n");

	it("renders a latency row with total, p50, p95 and queue wait", () => {
		const readRow = lines.find(l => l.trim().startsWith("read") && l.includes("200ms"));
		expect(readRow).toBeDefined();
		expect(readRow).toContain("600ms");
		expect(readRow).toContain("200ms");
		expect(readRow).toContain("300ms");
		expect(readRow).toContain("35ms");
	});

	it("renders the repeated-call row with the args fingerprint and count", () => {
		expect(text).toContain("Repeated identical calls");
		const row = lines.find(l => l.includes("aaaa1111"));
		expect(row).toContain("read");
		expect(row).toContain("aaaa1111");
		expect(row).toContain("2");
	});

	it("renders a per-turn row with model, request time and token total", () => {
		expect(text).toContain("Per-turn");
		const turn1 = lines.find(l => l.trim().startsWith("#1"));
		expect(turn1).toContain("anthropic/claude");
		expect(turn1).toContain("300ms");
		expect(turn1).toContain("180");
	});
});

describe("formatSessionStats non-silent truncation (Law 10)", () => {
	it("caps repeated calls at 25 and states how many were withheld", () => {
		const repeatedCalls = Array.from({ length: 30 }, (_, i) => ({
			tool: "read",
			argsHash: `h${i}`,
			count: 2,
			totalDurationMs: 100,
			totalResultTokens: 10,
		}));
		expect(line(formatSessionStats(report({ repeatedCalls })), "more")).toBe("  … 5 more (use --json for all)");
	});

	it("shows the 40 slowest turns in session order under a labelled note", () => {
		// requestMs === index, so the 40 slowest are indices 6..45. They must be
		// restored to ascending session order after being selected by slowness.
		const turns = Array.from({ length: 45 }, (_, i) => turn(i + 1, i + 1));
		const text = formatSessionStats(report({ turns }));
		expect(line(text, "Per-turn")).toBe("Per-turn (40 slowest of 45; --json for all)");
		const shown = text
			.split("\n")
			.map(l => l.trim())
			.filter(l => l.startsWith("#"))
			.map(l => l.split(/\s+/)[0]);
		expect(shown.length).toBe(40);
		expect(shown[0]).toBe("#6");
		expect(shown[shown.length - 1]).toBe("#45");
	});

	it("shows every turn with no note when under the cap", () => {
		const turns = [turn(1, 10), turn(2, 20), turn(3, 30)];
		const text = formatSessionStats(report({ turns }));
		expect(line(text, "Per-turn")).toBe("Per-turn");
	});
});
