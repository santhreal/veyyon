import { describe, expect, it } from "bun:test";
import { computeSessionStats, percentile } from "../../src/cli/session-stats";
import type { FileEntry } from "../../src/session/session-entries";

/**
 * computeSessionStats is the pure, I/O-free core behind `veyyon session stats`:
 * it walks a session's loaded entries once and reduces them to the aggregates a
 * user studies after a run (per-turn cost, tool latency percentiles, tool token
 * cost, repeated identical calls, scheduler wait, wall-clock span). The command
 * layer only resolves the file and renders; every number is decided here, yet
 * the reducer had no direct test (only an AgentSession integration test existed).
 *
 * These tests script exact entries and assert exact aggregate values, locking
 * the load-bearing contracts that a refactor could silently break:
 *   - Tool results attribute to the MOST RECENT assistant turn; a result before
 *     any turn (or a user message in between) must not misattribute.
 *   - toolCalls counts every tool result; instrumentedToolCalls counts only
 *     those carrying a metrics record, so a session recorded at `off` still
 *     yields turn/usage totals but no timing.
 *   - Latency percentiles are nearest-rank over only the TIMED calls; a tool
 *     with no durationMs contributes calls but timed=0 and zeroed percentiles.
 *   - Sort orders are stable and meaningful: latency by total duration desc then
 *     name; cost by result tokens desc then name; repeats by count desc then
 *     total duration then name, and a call seen once is NOT a repeat.
 *   - instrumentationLevel is the MAX level observed; wallClockMs spans only
 *     message timestamps (the non-message header is skipped); developer messages
 *     count as user messages.
 */

const header = (id: string, cwd: string): FileEntry =>
	({ type: "session", id, cwd, timestamp: "0" }) as unknown as FileEntry;

const message = (msg: unknown, ts: number): FileEntry =>
	({ type: "message", id: "e", parentId: null, timestamp: String(ts), message: msg }) as unknown as FileEntry;

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, totalTokens: number) => ({
	input,
	output,
	cacheRead,
	cacheWrite,
	totalTokens,
});

const assistant = (model: string, ts: number, duration: number | undefined, u: ReturnType<typeof usage>): FileEntry =>
	message({ role: "assistant", model, timestamp: ts, duration, usage: u, content: [] }, ts);

const user = (ts: number): FileEntry => message({ role: "user", timestamp: ts, content: "hi" }, ts);

const developer = (ts: number): FileEntry => message({ role: "developer", timestamp: ts, content: "sys" }, ts);

const toolResult = (toolName: string, ts: number, isError: boolean, metrics: unknown): FileEntry =>
	message({ role: "toolResult", toolName, timestamp: ts, isError, metrics, content: [] }, ts);

describe("percentile (nearest-rank)", () => {
	it("returns 0 for an empty array", () => {
		expect(percentile([], 50)).toBe(0);
	});

	it("returns the nearest-rank element for the 50th percentile", () => {
		// ceil(0.5 * 4) = 2 -> index 1
		expect(percentile([10, 20, 30, 40], 50)).toBe(20);
	});

	it("returns the top element for the 95th percentile of four values", () => {
		// ceil(0.95 * 4) = 4 -> index 3
		expect(percentile([10, 20, 30, 40], 95)).toBe(40);
	});

	it("returns the only element for a single-value array at any percentile", () => {
		expect(percentile([7], 95)).toBe(7);
	});

	it("clamps the 100th percentile to the last element", () => {
		expect(percentile([10, 20, 30, 40], 100)).toBe(40);
	});
});

describe("computeSessionStats", () => {
	it("reduces a mixed session to exact aggregates", () => {
		const entries: FileEntry[] = [
			header("s1", "/repo"),
			assistant("m1", 1000, 500, usage(100, 20, 10, 5, 135)),
			toolResult("read", 1100, false, {
				level: "rich",
				startedAt: 1070,
				endedAt: 1100,
				durationMs: 30,
				status: "ok",
				queuedMs: 5,
				resultTokens: 50,
				resultBytes: 200,
				argsHash: "h1",
			}),
			toolResult("read", 1200, false, {
				level: "rich",
				startedAt: 1190,
				endedAt: 1200,
				durationMs: 10,
				status: "ok",
				queuedMs: 2,
				resultTokens: 40,
				resultBytes: 150,
				argsHash: "h1",
			}),
			toolResult("grep", 1300, true, {
				level: "basic",
				startedAt: 1200,
				endedAt: 1300,
				durationMs: 100,
				status: "error",
			}),
			user(1400),
			assistant("m2", 1500, 200, usage(50, 10, 0, 0, 60)),
			toolResult("read", 1600, false, {
				level: "ultra",
				startedAt: 1580,
				endedAt: 1600,
				durationMs: 20,
				status: "ok",
				queuedMs: 1,
				resultTokens: 30,
				resultBytes: 120,
				argsHash: "h2",
			}),
			// A tool result with NO metrics: counted as a call, but not instrumented.
			toolResult("write", 1700, false, undefined),
		];

		expect(computeSessionStats(entries)).toEqual({
			sessionId: "s1",
			cwd: "/repo",
			messages: 8,
			instrumentationLevel: "ultra",
			totals: {
				assistantTurns: 2,
				userMessages: 1,
				toolCalls: 5,
				instrumentedToolCalls: 4,
				toolErrors: 1,
				input: 150,
				output: 30,
				cacheRead: 10,
				cacheWrite: 5,
				totalTokens: 195,
				requestMs: 700,
				toolDurationMs: 160,
				queueWaitMs: 8,
				resultTokens: 120,
				resultBytes: 470,
				wallClockMs: 700,
			},
			turns: [
				{
					index: 1,
					model: "m1",
					timestamp: 1000,
					requestMs: 500,
					input: 100,
					output: 20,
					cacheRead: 10,
					cacheWrite: 5,
					totalTokens: 135,
					toolCalls: 3,
				},
				{
					index: 2,
					model: "m2",
					timestamp: 1500,
					requestMs: 200,
					input: 50,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 60,
					toolCalls: 2,
				},
			],
			toolLatency: [
				// Slowest by total duration first: grep(100) > read(60) > write(0).
				{
					tool: "grep",
					calls: 1,
					timed: 1,
					totalDurationMs: 100,
					p50DurationMs: 100,
					p95DurationMs: 100,
					maxDurationMs: 100,
					queueWaitMs: 0,
					errors: 1,
				},
				{
					tool: "read",
					calls: 3,
					timed: 3,
					totalDurationMs: 60,
					p50DurationMs: 20,
					p95DurationMs: 30,
					maxDurationMs: 30,
					queueWaitMs: 8,
					errors: 0,
				},
				{
					tool: "write",
					calls: 1,
					timed: 0,
					totalDurationMs: 0,
					p50DurationMs: 0,
					p95DurationMs: 0,
					maxDurationMs: 0,
					queueWaitMs: 0,
					errors: 0,
				},
			],
			toolCost: [
				// Highest result-token weight first: read(120) > grep(0) > write(0), ties by name.
				{ tool: "read", calls: 3, resultTokens: 120, resultBytes: 470 },
				{ tool: "grep", calls: 1, resultTokens: 0, resultBytes: 0 },
				{ tool: "write", calls: 1, resultTokens: 0, resultBytes: 0 },
			],
			repeatedCalls: [
				// Only h1 repeated (count 2); h2 seen once is excluded.
				{ tool: "read", argsHash: "h1", count: 2, totalDurationMs: 40, totalResultTokens: 90 },
			],
		});
	});

	it("returns a fully zeroed report for no entries", () => {
		expect(computeSessionStats([])).toEqual({
			sessionId: "",
			cwd: "",
			messages: 0,
			instrumentationLevel: "off",
			totals: {
				assistantTurns: 0,
				userMessages: 0,
				toolCalls: 0,
				instrumentedToolCalls: 0,
				toolErrors: 0,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				requestMs: 0,
				toolDurationMs: 0,
				queueWaitMs: 0,
				resultTokens: 0,
				resultBytes: 0,
				wallClockMs: 0,
			},
			turns: [],
			toolLatency: [],
			toolCost: [],
			repeatedCalls: [],
		});
	});

	it("counts developer messages as user messages and does not misattribute an orphan tool result", () => {
		const entries: FileEntry[] = [
			developer(100),
			// Tool result BEFORE any assistant turn: counted in totals, attributed to no turn.
			toolResult("read", 150, false, {
				level: "basic",
				startedAt: 140,
				endedAt: 150,
				durationMs: 10,
				status: "ok",
			}),
			assistant("m", 200, undefined, usage(1, 1, 0, 0, 2)),
		];

		const report = computeSessionStats(entries);
		expect(report.totals.userMessages).toBe(1);
		expect(report.totals.toolCalls).toBe(1);
		expect(report.turns).toHaveLength(1);
		// The orphan read is not attributed to the later turn.
		expect(report.turns[0]!.toolCalls).toBe(0);
		// The turn had no provider duration, so requestMs stays undefined and totals stay 0.
		expect(report.turns[0]!.requestMs).toBeUndefined();
		expect(report.totals.requestMs).toBe(0);
		// wallClock spans first (100) to last (200) message timestamp.
		expect(report.totals.wallClockMs).toBe(100);
		expect(report.instrumentationLevel).toBe("basic");
	});

	it("still reports turns and usage for a wholly-uninstrumented session", () => {
		// A session recorded at instrumentation `off` carries tool results with no metrics
		// record. They must still count as calls (with usage/turn totals intact) but yield
		// zero timing and no repeats, and the reported level must be "off".
		const entries: FileEntry[] = [
			header("s1", "/repo"),
			assistant("m1", 1000, 100, usage(10, 5, 0, 0, 15)),
			toolResult("read", 1100, false, undefined),
		];
		const report = computeSessionStats(entries);
		expect(report.instrumentationLevel).toBe("off");
		expect(report.totals.toolCalls).toBe(1);
		expect(report.totals.instrumentedToolCalls).toBe(0);
		expect(report.totals.totalTokens).toBe(15);
		expect(report.totals.toolDurationMs).toBe(0);
		expect(report.toolLatency[0]).toMatchObject({ tool: "read", calls: 1, timed: 0, totalDurationMs: 0 });
		expect(report.repeatedCalls).toEqual([]);
	});

	it("ignores non-message entries but still reads the session header", () => {
		const entries: FileEntry[] = [
			header("S", "/c"),
			{ type: "thinking_level_change", id: "t", parentId: null, timestamp: "1" } as unknown as FileEntry,
			assistant("m", 5, 9, usage(2, 3, 0, 0, 5)),
		];

		const report = computeSessionStats(entries);
		expect(report.messages).toBe(1);
		expect(report.turns).toHaveLength(1);
		expect(report.sessionId).toBe("S");
		expect(report.cwd).toBe("/c");
	});
});
