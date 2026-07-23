/**
 * Session study analysis — the pure core behind `veyyon session stats`.
 *
 * Given a session's loaded entries, this walks the messages once and reduces
 * them to the aggregates you want when studying how a run spent its time: how
 * long each turn took and what it cost, which tools dominated latency, which
 * tools cost the most tokens in context, which exact calls repeated, and how
 * long calls waited in the scheduler. It reads only the data instrumentation
 * already persisted ({@link ToolCallMetrics} on each tool result plus the
 * assistant {@link Usage}); it never re-runs anything.
 *
 * This module has no I/O. The command layer resolves the file and loads the
 * entries; here we only compute and render, so the aggregates are exercised
 * directly by tests with scripted entries and exact expected values.
 */

import type { AssistantMessage, ToolCallMetrics, ToolResultMessage } from "@veyyon/ai";
import { type InstrumentationLevel, instrumentationRank } from "@veyyon/ai";
import { clamp } from "@veyyon/utils";
import type { FileEntry, SessionHeader, SessionMessageEntry } from "../session/session-entries";

/** One assistant request and the tool calls it drove, with token cost. */
export interface TurnStat {
	/** 1-based order of the assistant turn within the session. */
	index: number;
	model: string;
	timestamp: number;
	/** Provider-reported request wall-clock, when the turn recorded it. */
	requestMs?: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	/** Tool results attributed to this turn (calls it requested). */
	toolCalls: number;
}

/** Latency profile for one tool across every call in the session. */
export interface ToolLatencyStat {
	tool: string;
	calls: number;
	/** Calls that carried a `durationMs` metric (the p-values are over these). */
	timed: number;
	totalDurationMs: number;
	p50DurationMs: number;
	p95DurationMs: number;
	maxDurationMs: number;
	/** Total scheduler wait across this tool's calls (from `queuedMs`). */
	queueWaitMs: number;
	errors: number;
}

/** How much context weight one tool added, for cost ranking. */
export interface ToolCostStat {
	tool: string;
	calls: number;
	/** Sum of `resultTokens` (the weight the model pays to keep these results). */
	resultTokens: number;
	resultBytes: number;
}

/** A tool called more than once with byte-identical arguments. */
export interface RepeatedCall {
	tool: string;
	argsHash: string;
	count: number;
	totalDurationMs: number;
	totalResultTokens: number;
}

export interface SessionStatsTotals {
	assistantTurns: number;
	userMessages: number;
	toolCalls: number;
	/** Tool calls that carried a metrics record (instrumentation was on). */
	instrumentedToolCalls: number;
	toolErrors: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	/** Sum of provider request durations across turns that reported one. */
	requestMs: number;
	/** Sum of tool execution durations (from `durationMs`). */
	toolDurationMs: number;
	/** Sum of scheduler wait across all calls (from `queuedMs`). */
	queueWaitMs: number;
	/** Sum of `resultTokens` across all instrumented calls. */
	resultTokens: number;
	resultBytes: number;
	/** Span from the first to the last message timestamp. */
	wallClockMs: number;
}

export interface SessionStatsReport {
	sessionId: string;
	cwd: string;
	messages: number;
	/** Highest instrumentation level observed on any tool result, or `off`. */
	instrumentationLevel: InstrumentationLevel;
	totals: SessionStatsTotals;
	turns: TurnStat[];
	toolLatency: ToolLatencyStat[];
	toolCost: ToolCostStat[];
	repeatedCalls: RepeatedCall[];
}

/**
 * Nearest-rank percentile of an ascending-sorted array. Deterministic and
 * dependency-free so tests assert exact values: `p` of 50 over `[10,20,30,40]`
 * is the 2nd element (20), `p` of 95 is the 4th (40). Empty input is 0.
 */
export function percentile(sortedAsc: readonly number[], p: number): number {
	if (sortedAsc.length === 0) return 0;
	const rank = Math.ceil((p / 100) * sortedAsc.length);
	const index = clamp(rank - 1, 0, sortedAsc.length - 1);
	return sortedAsc[index];
}

function isMessageEntry(entry: FileEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

/** Per-tool mutable accumulator, resolved to the exported stats at the end. */
interface ToolAccumulator {
	calls: number;
	errors: number;
	durations: number[];
	queueWaitMs: number;
	resultTokens: number;
	resultBytes: number;
}

function emptyToolAccumulator(): ToolAccumulator {
	return { calls: 0, errors: 0, durations: [], queueWaitMs: 0, resultTokens: 0, resultBytes: 0 };
}

function turnFromAssistant(message: AssistantMessage, index: number): TurnStat {
	const usage = message.usage;
	return {
		index,
		model: message.model,
		timestamp: message.timestamp,
		requestMs: message.duration,
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		toolCalls: 0,
	};
}

/**
 * Reduce a session's loaded entries to its study report. Tool results are
 * attributed to the most recent assistant turn, matching how a turn drives the
 * calls that follow it. Missing metrics are skipped, never guessed: a session
 * recorded at `off` still produces turn and usage totals, just no tool timing.
 */
export function computeSessionStats(entries: readonly FileEntry[]): SessionStatsReport {
	const header = entries[0]?.type === "session" ? (entries[0] as SessionHeader) : undefined;
	const totals: SessionStatsTotals = {
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
	};
	const turns: TurnStat[] = [];
	const tools = new Map<string, ToolAccumulator>();
	const repeats = new Map<string, RepeatedCall>();

	let messages = 0;
	let firstTs: number | undefined;
	let lastTs: number | undefined;
	let maxLevelRank = 0;
	let maxLevel: InstrumentationLevel = "off";
	let currentTurn: TurnStat | undefined;

	const note = (ts: number) => {
		if (typeof ts !== "number") return;
		if (firstTs === undefined || ts < firstTs) firstTs = ts;
		if (lastTs === undefined || ts > lastTs) lastTs = ts;
	};

	for (const entry of entries) {
		if (!isMessageEntry(entry)) continue;
		const message = entry.message;
		messages += 1;

		if (message.role === "assistant") {
			note(message.timestamp);
			const turn = turnFromAssistant(message, turns.length + 1);
			turns.push(turn);
			currentTurn = turn;
			totals.assistantTurns += 1;
			totals.input += turn.input;
			totals.output += turn.output;
			totals.cacheRead += turn.cacheRead;
			totals.cacheWrite += turn.cacheWrite;
			totals.totalTokens += turn.totalTokens;
			if (turn.requestMs !== undefined) totals.requestMs += turn.requestMs;
			continue;
		}

		if (message.role === "user" || message.role === "developer") {
			note(message.timestamp);
			totals.userMessages += 1;
			continue;
		}

		if (message.role === "toolResult") {
			accumulateToolResult(message, {
				totals,
				tools,
				repeats,
				currentTurn,
				note,
				bumpLevel: (level: ToolCallMetrics["level"]) => {
					const rank = instrumentationRank(level);
					if (rank > maxLevelRank) {
						maxLevelRank = rank;
						maxLevel = level;
					}
				},
			});
		}
	}

	if (firstTs !== undefined && lastTs !== undefined) totals.wallClockMs = lastTs - firstTs;

	return {
		sessionId: header?.id ?? "",
		cwd: header?.cwd ?? "",
		messages,
		instrumentationLevel: maxLevel,
		totals,
		turns,
		toolLatency: resolveToolLatency(tools),
		toolCost: resolveToolCost(tools),
		repeatedCalls: resolveRepeats(repeats),
	};
}

interface ToolResultSink {
	totals: SessionStatsTotals;
	tools: Map<string, ToolAccumulator>;
	repeats: Map<string, RepeatedCall>;
	currentTurn: TurnStat | undefined;
	note: (ts: number) => void;
	bumpLevel: (level: ToolCallMetrics["level"]) => void;
}

function accumulateToolResult(message: ToolResultMessage, sink: ToolResultSink): void {
	const { totals, tools, repeats, currentTurn, note } = sink;
	note(message.timestamp);
	totals.toolCalls += 1;
	if (currentTurn) currentTurn.toolCalls += 1;

	const acc = tools.get(message.toolName) ?? emptyToolAccumulator();
	tools.set(message.toolName, acc);
	acc.calls += 1;
	if (message.isError) {
		acc.errors += 1;
		totals.toolErrors += 1;
	}

	const metrics = message.metrics;
	if (!metrics) return;
	totals.instrumentedToolCalls += 1;
	sink.bumpLevel(metrics.level);

	if (typeof metrics.durationMs === "number") {
		acc.durations.push(metrics.durationMs);
		totals.toolDurationMs += metrics.durationMs;
	}
	if (typeof metrics.queuedMs === "number") {
		acc.queueWaitMs += metrics.queuedMs;
		totals.queueWaitMs += metrics.queuedMs;
	}
	if (typeof metrics.resultTokens === "number") {
		acc.resultTokens += metrics.resultTokens;
		totals.resultTokens += metrics.resultTokens;
	}
	if (typeof metrics.resultBytes === "number") {
		acc.resultBytes += metrics.resultBytes;
		totals.resultBytes += metrics.resultBytes;
	}

	if (metrics.argsHash) {
		const key = `${message.toolName}\u0000${metrics.argsHash}`;
		const repeat = repeats.get(key) ?? {
			tool: message.toolName,
			argsHash: metrics.argsHash,
			count: 0,
			totalDurationMs: 0,
			totalResultTokens: 0,
		};
		repeat.count += 1;
		repeat.totalDurationMs += metrics.durationMs ?? 0;
		repeat.totalResultTokens += metrics.resultTokens ?? 0;
		repeats.set(key, repeat);
	}
}

function resolveToolLatency(tools: Map<string, ToolAccumulator>): ToolLatencyStat[] {
	const stats: ToolLatencyStat[] = [];
	for (const [tool, acc] of tools) {
		const sorted = [...acc.durations].sort((a, b) => a - b);
		stats.push({
			tool,
			calls: acc.calls,
			timed: sorted.length,
			totalDurationMs: sorted.reduce((sum, d) => sum + d, 0),
			p50DurationMs: percentile(sorted, 50),
			p95DurationMs: percentile(sorted, 95),
			maxDurationMs: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
			queueWaitMs: acc.queueWaitMs,
			errors: acc.errors,
		});
	}
	// Slowest tool first; ties broken by name so the order is stable.
	stats.sort((a, b) => b.totalDurationMs - a.totalDurationMs || a.tool.localeCompare(b.tool));
	return stats;
}

function resolveToolCost(tools: Map<string, ToolAccumulator>): ToolCostStat[] {
	const stats: ToolCostStat[] = [];
	for (const [tool, acc] of tools) {
		stats.push({ tool, calls: acc.calls, resultTokens: acc.resultTokens, resultBytes: acc.resultBytes });
	}
	stats.sort((a, b) => b.resultTokens - a.resultTokens || a.tool.localeCompare(b.tool));
	return stats;
}

function resolveRepeats(repeats: Map<string, RepeatedCall>): RepeatedCall[] {
	const stats = [...repeats.values()].filter(r => r.count > 1);
	// Most-repeated first; ties by total time spent, then tool name.
	stats.sort((a, b) => b.count - a.count || b.totalDurationMs - a.totalDurationMs || a.tool.localeCompare(b.tool));
	return stats;
}
