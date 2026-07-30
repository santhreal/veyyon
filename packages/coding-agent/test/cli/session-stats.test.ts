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

const sequenced = (entry: FileEntry, sequence: number): FileEntry =>
	({ ...(entry as unknown as Record<string, unknown>), sequence }) as unknown as FileEntry;

const assistantWithContext = (ts: number, contextSnapshot: Record<string, unknown>): FileEntry =>
	message(
		{
			role: "assistant",
			model: "m",
			timestamp: ts,
			usage: usage(10, 2, 0, 0, 12),
			content: [],
			contextSnapshot,
		},
		ts,
	);

const toolResultWithDetails = (toolName: string, ts: number, metrics: unknown, details: unknown): FileEntry =>
	message({ role: "toolResult", toolName, timestamp: ts, isError: false, metrics, details, content: [] }, ts);

const metadata = (customType: string, data: unknown, sequence?: number): FileEntry =>
	({
		type: "custom",
		customType,
		data,
		id: `custom-${sequence ?? 0}`,
		parentId: null,
		timestamp: String(sequence ?? 0),
		...(sequence === undefined ? {} : { sequence }),
	}) as unknown as FileEntry;

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
			toolSpans: {
				calls: 4,
				statuses: { ok: 3, error: 1, aborted: 0, blocked: 0, skipped: 0 },
				useless: 0,
				rich: {
					queuedMs: 8,
					shared: 0,
					exclusive: 0,
					batches: 0,
					maxBatchSize: 0,
					resultBlocks: 0,
					resultImages: 0,
				},
				ultra: {
					argsBytes: 0,
					uniqueArgs: 2,
					interruptible: { true: 0, false: 0 },
					signalAborted: { true: 0, false: 0 },
				},
			},
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
		expect(report.lifecycle).toBeUndefined();
		expect(report.context).toBeUndefined();
		expect(report.toolSpans).toBeUndefined();
		expect(report.ircDelivery).toBeUndefined();
		expect(report.taskState).toBeUndefined();
	});

	it("keeps instrumentation off while reporting context categories that an off session persisted", () => {
		const report = computeSessionStats([
			header("off", "/repo"),
			assistantWithContext(1, { promptTokens: 90, nonMessageTokens: 25 }),
			toolResult("read", 2, false, undefined),
		]);

		expect(report.instrumentationLevel).toBe("off");
		expect(report.context).toEqual({
			snapshots: 1,
			promptTokens: { observations: 1, total: 90, max: 90 },
			nonMessageTokens: { observations: 1, total: 25, max: 25 },
		});
		expect(report.context).not.toHaveProperty("storedMessagesTokens");
		expect(report.lifecycle).toBeUndefined();
		expect(report.toolSpans).toBeUndefined();
		expect(report.ircDelivery).toBeUndefined();
		expect(report.taskState).toBeUndefined();
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

	it("reports configured ultra instrumentation from a lifecycle-only session", () => {
		const report = computeSessionStats([
			header("lifecycle-ultra", "/repo"),
			{
				type: "session_lifecycle",
				id: "life-ultra",
				parentId: null,
				timestamp: "1",
				sequence: 1,
				state: "running",
				reason: "resumed",
				instrumentationLevel: "ultra",
			} as unknown as FileEntry,
		]);

		expect(report.instrumentationLevel).toBe("ultra");
		expect(report.lifecycle).toEqual({
			transitions: 1,
			checkpoints: 0,
			sequence: { entries: 1, first: 1, last: 1, highest: 1 },
			latestState: { state: "running", reason: "resumed", sequence: 1 },
		});
	});

	it("rolls up only basic lifecycle, context, tool-span, and task-state facts", () => {
		const taskTelemetry = {
			operation: "init",
			counts: { total: 2, open: 2, inProgress: 1, dropped: 0, completed: 0 },
			transitions: {
				total: 2,
				added: 2,
				removed: 0,
				toPending: 1,
				toInProgress: 1,
				toDropped: 0,
				toCompleted: 0,
			},
		};
		const entries: FileEntry[] = [
			header("basic", "/repo"),
			{
				type: "session_lifecycle",
				id: "life-1",
				parentId: null,
				timestamp: "1",
				sequence: 1,
				state: "running",
				reason: "created",
			} as FileEntry,
			sequenced(assistantWithContext(2, { promptTokens: 100, nonMessageTokens: 20 }), 2),
			sequenced(
				toolResultWithDetails(
					"todo",
					3,
					{
						level: "basic",
						startedAt: 1,
						endedAt: 3,
						durationMs: 2,
						status: "blocked",
					},
					{ telemetry: taskTelemetry },
				),
				3,
			),
			{
				type: "session_checkpoint",
				id: "checkpoint-4",
				parentId: null,
				timestamp: "4",
				sequence: 4,
				prefixSequence: 3,
			} as FileEntry,
			{
				type: "session_lifecycle",
				id: "life-5",
				parentId: null,
				timestamp: "5",
				sequence: 5,
				state: "ended",
				reason: "closed",
			} as FileEntry,
		];

		const report = computeSessionStats(entries);
		expect(report.instrumentationLevel).toBe("basic");
		expect(report.lifecycle).toEqual({
			transitions: 2,
			checkpoints: 1,
			sequence: { entries: 5, first: 1, last: 5, highest: 5 },
			latestCheckpoint: { id: "checkpoint-4", prefixSequence: 3, sequence: 4 },
			latestState: { state: "ended", reason: "closed", sequence: 5 },
		});
		expect(report.context).toEqual({
			snapshots: 1,
			promptTokens: { observations: 1, total: 100, max: 100 },
			nonMessageTokens: { observations: 1, total: 20, max: 20 },
		});
		expect(report.toolSpans).toEqual({
			calls: 1,
			statuses: { ok: 0, error: 0, aborted: 0, blocked: 1, skipped: 0 },
			useless: 0,
		});
		expect(report.taskState).toEqual({
			operations: 1,
			byOperation: { init: 1 },
			latest: { total: 2, open: 2, inProgress: 1, dropped: 0, completed: 0 },
			transitions: taskTelemetry.transitions,
		});
		expect(report.ircDelivery).toBeUndefined();
		expect(report.context).not.toHaveProperty("storedMessagesTokens");
		expect(report.toolSpans).not.toHaveProperty("rich");
	});

	it("adds rich attribution, scheduling, and IRC delivery rollups without ultra fields", () => {
		const report = computeSessionStats([
			header("rich", "/repo"),
			assistantWithContext(10, {
				promptTokens: 80,
				nonMessageTokens: 20,
				storedMessagesTokens: 50,
				tailTokens: 10,
				promptTokensSource: "provider",
				nonMessageTokensEstimated: true,
				storedMessagesTokensEstimated: true,
				tailTokensEstimated: true,
			}),
			toolResultWithDetails(
				"todo",
				12,
				{
					level: "rich",
					startedAt: 10,
					endedAt: 12,
					durationMs: 2,
					status: "ok",
					queuedMs: 3,
					concurrency: "shared",
					batchId: "b1",
					batchIndex: 0,
					batchSize: 2,
					resultBytes: 40,
					resultBlocks: 3,
					resultImages: 1,
					resultTokens: 10,
				},
				{
					telemetry: {
						operation: "done",
						counts: { total: 2, open: 1, inProgress: 1, dropped: 0, completed: 1 },
						transitions: {
							total: 1,
							added: 0,
							removed: 0,
							toPending: 0,
							toInProgress: 0,
							toDropped: 0,
							toCompleted: 1,
						},
						before: { total: 2, open: 2, inProgress: 1, dropped: 0, completed: 0 },
						affectedTasks: [{ phase: "work", task: "one" }],
					},
				},
			),
			metadata("irc:delivery-telemetry", {
				level: "rich",
				messageId: "msg-rich",
				direction: "sent",
				outcome: "woken",
				payloadBytes: 32,
			}),
		]);

		expect(report.instrumentationLevel).toBe("rich");
		expect(report.context).toMatchObject({
			storedMessagesTokens: { observations: 1, total: 50, max: 50 },
			tailTokens: { observations: 1, total: 10, max: 10 },
			promptTokenSources: { provider: 1, estimate: 0 },
			estimated: {
				nonMessageTokens: { true: 1, false: 0 },
				storedMessagesTokens: { true: 1, false: 0 },
				tailTokens: { true: 1, false: 0 },
			},
		});
		expect(report.context).not.toHaveProperty("compactionEntryIds");
		expect(report.toolSpans?.rich).toEqual({
			queuedMs: 3,
			shared: 1,
			exclusive: 0,
			batches: 1,
			maxBatchSize: 2,
			resultBlocks: 3,
			resultImages: 1,
		});
		expect(report.toolSpans).not.toHaveProperty("ultra");
		expect(report.ircDelivery).toEqual({
			sent: {
				count: 1,
				payloadBytes: 32,
				outcomes: { injected: 0, woken: 1, revived: 0, failed: 0 },
			},
			received: {
				count: 0,
				payloadBytes: 0,
				outcomes: { injected: 0, woken: 0, revived: 0, failed: 0 },
			},
		});
		expect(report.ircDelivery?.sent).not.toHaveProperty("routes");
		expect(report.taskState?.latest?.completed).toBe(1);
	});

	it("adds only persisted ultra route, compaction, argument, and transition detail", () => {
		const report = computeSessionStats([
			header("ultra", "/repo"),
			assistantWithContext(20, {
				promptTokens: 120,
				nonMessageTokens: 30,
				storedMessagesTokens: 70,
				tailTokens: 20,
				promptTokensSource: "estimate",
				compactionEntryId: "compact-1",
			}),
			toolResultWithDetails(
				"todo",
				25,
				{
					level: "ultra",
					startedAt: 20,
					endedAt: 25,
					durationMs: 5,
					status: "aborted",
					queuedMs: 1,
					concurrency: "exclusive",
					batchId: "b2",
					batchIndex: 0,
					batchSize: 1,
					resultBytes: 5,
					resultBlocks: 1,
					resultImages: 0,
					resultTokens: 2,
					argsBytes: 18,
					argsHash: "args-1",
					interruptible: true,
					signalAborted: true,
				},
				{
					telemetry: {
						operation: "drop",
						counts: { total: 1, open: 0, inProgress: 0, dropped: 1, completed: 0 },
						transitions: {
							total: 1,
							added: 0,
							removed: 0,
							toPending: 0,
							toInProgress: 0,
							toDropped: 1,
							toCompleted: 0,
						},
						taskTransitions: [{ ref: { phase: "work", task: "one" }, from: "in_progress", to: "abandoned" }],
					},
				},
			),
			metadata("irc:delivery-telemetry", {
				level: "ultra",
				messageId: "msg-ultra",
				direction: "received",
				outcome: "revived",
				payloadBytes: 64,
				sender: "Main",
				recipientClass: "parked",
				route: "revival",
				revived: true,
				deliveryLatencyMs: 7,
				messageKind: "send",
			}),
			// A duplicate journal record for the same direction/message is not a second delivery.
			metadata("irc:delivery-telemetry", {
				level: "ultra",
				messageId: "msg-ultra",
				direction: "received",
				outcome: "revived",
				payloadBytes: 64,
				sender: "Main",
				recipientClass: "parked",
				route: "revival",
				revived: true,
				deliveryLatencyMs: 7,
				messageKind: "send",
			}),
		]);

		expect(report.instrumentationLevel).toBe("ultra");
		expect(report.context?.compactionEntryIds).toEqual(["compact-1"]);
		expect(report.context?.compactionEntries).toBe(1);
		expect(report.toolSpans?.ultra).toEqual({
			argsBytes: 18,
			uniqueArgs: 1,
			interruptible: { true: 1, false: 0 },
			signalAborted: { true: 1, false: 0 },
		});
		expect(report.ircDelivery).toMatchObject({
			sent: {
				count: 0,
				payloadBytes: 0,
				outcomes: { injected: 0, woken: 0, revived: 0, failed: 0 },
			},
			received: {
				count: 1,
				payloadBytes: 64,
				outcomes: { injected: 0, woken: 0, revived: 1, failed: 0 },
				routes: { revival: 1 },
				revived: { true: 1, false: 0 },
				deliveryLatencyMs: { observations: 1, total: 7, max: 7 },
				recipientClasses: { parked: 1 },
				messageKinds: { send: 1 },
			},
		});
		expect(report.taskState?.transitions.toDropped).toBe(1);
		expect(report.taskState).not.toHaveProperty("blocked");
		expect(report.taskState).not.toHaveProperty("verification");
		expect(report.taskState).not.toHaveProperty("retries");
	});

	/**
	 * High-cardinality compaction history must stay linear to reduce and bounded
	 * in the JSON report rather than retaining an unbounded terminal payload.
	 */
	it("bounds compaction id samples while counting every unique entry", () => {
		const entries: FileEntry[] = [header("many-compactions", "/repo")];
		for (let index = 0; index < 10_000; index++) {
			entries.push(
				assistantWithContext(index, {
					promptTokens: 10,
					nonMessageTokens: 2,
					compactionEntryId: `compact-${index}`,
				}),
			);
		}

		const report = computeSessionStats(entries);

		expect(report.context?.compactionEntries).toBe(10_000);
		expect(report.context?.compactionEntryIds).toHaveLength(16);
		expect(report.context?.compactionEntryIds?.[0]).toBe("compact-9984");
		expect(report.context?.compactionEntryIds?.at(-1)).toBe("compact-9999");
	});

	/**
	 * All-session task transition totals include abandoned branches, but the
	 * latest task state must describe only the active leaf ancestry.
	 */
	it("does not report abandoned-branch task state as the active latest state", () => {
		const transitions = {
			total: 1,
			added: 1,
			removed: 0,
			toPending: 1,
			toInProgress: 0,
			toDropped: 0,
			toCompleted: 0,
		};
		const entries = [
			header("branched-tasks", "/repo"),
			{
				type: "message",
				id: "root",
				parentId: null,
				timestamp: "1",
				message: { role: "user", timestamp: 1, content: "root" },
			},
			{
				type: "message",
				id: "abandoned-todo",
				parentId: "root",
				timestamp: "2",
				message: {
					role: "toolResult",
					toolName: "todo",
					timestamp: 2,
					content: [],
					details: {
						telemetry: {
							operation: "init",
							counts: { total: 9, open: 9, inProgress: 1, dropped: 0, completed: 0 },
							transitions,
						},
					},
				},
			},
			{
				type: "message",
				id: "active-leaf",
				parentId: "root",
				timestamp: "3",
				message: { role: "user", timestamp: 3, content: "new branch" },
			},
		] as unknown as FileEntry[];

		const report = computeSessionStats(entries);

		expect(report.taskState?.operations).toBe(1);
		expect(report.taskState?.transitions).toEqual(transitions);
		expect(report.taskState?.latest).toBeUndefined();
	});

	/**
	 * Legacy 32-bit hashes cannot be upgraded without raw arguments. Mixed
	 * sessions keep their legacy and strong digest namespaces separate rather
	 * than claiming cross-version calls are byte-identical.
	 */
	it("does not merge legacy and strong argument fingerprints", () => {
		const common = {
			level: "ultra",
			timeUnit: "ms",
			startedAt: 1,
			endedAt: 2,
			durationMs: 1,
			status: "ok",
			argsHash: "deadbeef",
		};
		const report = computeSessionStats([
			header("mixed-fingerprints", "/repo"),
			toolResult("read", 1, false, common),
			toolResult("read", 2, false, {
				...common,
				argsDigest: "0123456789abcdef0123456789abcdef",
				argsDigestAlgorithm: "sha256-128",
			}),
		]);

		expect(report.toolSpans?.ultra?.uniqueArgs).toBe(2);
		expect(report.repeatedCalls).toEqual([]);
	});
});
