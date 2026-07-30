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
// The rank from the module that defines it (1 module) rather than the barrel (346).
import { type InstrumentationLevel, instrumentationRank } from "@veyyon/ai/instrumentation";
import { clamp, isRecord } from "@veyyon/utils";

import type { FileEntry, SessionHeader, SessionLifecycleReason, SessionMessageEntry } from "../session/session-entries";

const COMPACTION_ENTRY_ID_SAMPLE_LIMIT = 16;

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

export interface NumericRollup {
	observations: number;
	total: number;
	max: number;
}

export interface BooleanRollup {
	true: number;
	false: number;
}

export interface LifecycleStats {
	transitions: number;
	checkpoints: number;
	sequence?: {
		entries: number;
		first: number;
		last: number;
		highest: number;
	};
	latestCheckpoint?: {
		id: string;
		prefixSequence: number;
		sequence?: number;
	};
	latestState?: {
		state: "running" | "ended";
		reason: SessionLifecycleReason;
		sequence?: number;
	};
}

export interface ContextAttributionStats {
	snapshots: number;
	promptTokens: NumericRollup;
	nonMessageTokens: NumericRollup;
	storedMessagesTokens?: NumericRollup;
	tailTokens?: NumericRollup;
	promptTokenSources?: {
		provider: number;
		estimate: number;
	};
	estimated?: {
		nonMessageTokens?: BooleanRollup;
		storedMessagesTokens?: BooleanRollup;
		tailTokens?: BooleanRollup;
	};
	/** Total distinct compaction entries observed across the session. */
	compactionEntries?: number;
	/** Bounded tail sample, oldest to newest, for JSON diagnostics. */
	compactionEntryIds?: string[];
}

export interface ToolSpanStats {
	calls: number;
	statuses: {
		ok: number;
		error: number;
		aborted: number;
		blocked: number;
		skipped: number;
	};
	useless: number;
	rich?: {
		queuedMs: number;
		shared: number;
		exclusive: number;
		batches: number;
		maxBatchSize: number;
		resultBlocks: number;
		resultImages: number;
	};
	ultra?: {
		argsBytes: number;
		uniqueArgs: number;
		interruptible: BooleanRollup;
		signalAborted: BooleanRollup;
	};
}

export interface IrcDeliveryDirectionStats {
	count: number;
	payloadBytes: number;
	outcomes: {
		injected: number;
		woken: number;
		revived: number;
		failed: number;
	};
	routes?: Record<string, number>;
	revived?: BooleanRollup;
	deliveryLatencyMs?: NumericRollup;
	recipientClasses?: Record<string, number>;
	messageKinds?: Record<string, number>;
}

export interface IrcDeliveryStats {
	sent: IrcDeliveryDirectionStats;
	received: IrcDeliveryDirectionStats;
}

export interface TaskStateStats {
	operations: number;
	byOperation: Record<string, number>;
	latest?: {
		total: number;
		open: number;
		inProgress: number;
		dropped: number;
		completed: number;
	};
	transitions: {
		total: number;
		added: number;
		removed: number;
		toPending: number;
		toInProgress: number;
		toDropped: number;
		toCompleted: number;
	};
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
	/** Present only when lifecycle telemetry entries were persisted. */
	lifecycle?: LifecycleStats;
	/** Present only when assistant turns carry a persisted context snapshot. */
	context?: ContextAttributionStats;
	/** Present only when tool calls carry instrumentation metrics. */
	toolSpans?: ToolSpanStats;
	/** Present only when persisted IRC delivery records exist. */
	ircDelivery?: IrcDeliveryStats;
	/** Present only when todo results carry task-state telemetry. */
	taskState?: TaskStateStats;
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

function addNumber(rollup: NumericRollup | undefined, value: number): NumericRollup {
	if (rollup) {
		rollup.observations += 1;
		rollup.total += value;
		rollup.max = Math.max(rollup.max, value);
		return rollup;
	}
	return { observations: 1, total: value, max: value };
}

function addBoolean(rollup: BooleanRollup | undefined, value: boolean): BooleanRollup {
	const result = rollup ?? { true: 0, false: 0 };
	result[String(value) as "true" | "false"] += 1;
	return result;
}

function increment(record: Record<string, number>, key: string): void {
	record[key] = (record[key] ?? 0) + 1;
}

function emptyToolSpanStats(): ToolSpanStats {
	return {
		calls: 0,
		statuses: { ok: 0, error: 0, aborted: 0, blocked: 0, skipped: 0 },
		useless: 0,
	};
}

function accumulateToolSpan(
	metrics: ToolCallMetrics,
	stats: ToolSpanStats,
	batches: Set<string>,
	argsHashes: Set<string>,
): void {
	stats.calls += 1;
	stats.statuses[metrics.status] += 1;
	if (metrics.uselessReason !== undefined) stats.useless += 1;

	const hasRich =
		metrics.queuedMs !== undefined ||
		metrics.concurrency !== undefined ||
		metrics.batchId !== undefined ||
		metrics.batchSize !== undefined ||
		metrics.resultBlocks !== undefined ||
		metrics.resultImages !== undefined;
	if (hasRich) {
		if (!stats.rich) {
			stats.rich = {
				queuedMs: 0,
				shared: 0,
				exclusive: 0,
				batches: 0,
				maxBatchSize: 0,
				resultBlocks: 0,
				resultImages: 0,
			};
		}
		const rich = stats.rich;
		rich.queuedMs += metrics.queuedMs ?? 0;
		if (metrics.concurrency) rich[metrics.concurrency] += 1;
		if (metrics.batchId) batches.add(metrics.batchId);
		rich.batches = batches.size;
		if (metrics.batchSize !== undefined) rich.maxBatchSize = Math.max(rich.maxBatchSize, metrics.batchSize);
		rich.resultBlocks += metrics.resultBlocks ?? 0;
		rich.resultImages += metrics.resultImages ?? 0;
	}

	const hasUltra =
		metrics.argsBytes !== undefined ||
		metrics.argsHash !== undefined ||
		metrics.interruptible !== undefined ||
		metrics.signalAborted !== undefined;
	if (hasUltra) {
		if (!stats.ultra) {
			stats.ultra = {
				argsBytes: 0,
				uniqueArgs: 0,
				interruptible: { true: 0, false: 0 },
				signalAborted: { true: 0, false: 0 },
			};
		}
		const ultra = stats.ultra;
		ultra.argsBytes += metrics.argsBytes ?? 0;
		if (metrics.argsDigest) {
			argsHashes.add(`${metrics.argsDigestAlgorithm ?? "sha256-128"}:${metrics.argsDigest}`);
		} else if (metrics.argsHash) {
			argsHashes.add(`legacy-fnv1a-32:${metrics.argsHash}`);
		}
		ultra.uniqueArgs = argsHashes.size;
		if (metrics.interruptible !== undefined) addBoolean(ultra.interruptible, metrics.interruptible);
		if (metrics.signalAborted !== undefined) addBoolean(ultra.signalAborted, metrics.signalAborted);
	}
}

function activeBranchEntryIds(entries: readonly FileEntry[]): Set<string> {
	const byId = new Map<string, { id: string; parentId: string | null }>();
	let latestEntry: { id: string; parentId: string | null } | undefined;
	let latestMessage: { id: string; parentId: string | null } | undefined;
	for (const entry of entries) {
		if (
			"id" in entry &&
			"parentId" in entry &&
			typeof entry.id === "string" &&
			(entry.parentId === null || typeof entry.parentId === "string")
		) {
			latestEntry = { id: entry.id, parentId: entry.parentId };
			byId.set(entry.id, latestEntry);
			if (entry.type === "message") latestMessage = latestEntry;
		}
	}
	let leaf = latestMessage ?? latestEntry;
	const active = new Set<string>();
	while (leaf && !active.has(leaf.id)) {
		active.add(leaf.id);
		leaf = leaf.parentId === null ? undefined : byId.get(leaf.parentId);
	}
	return active;
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
	const toolSpans = emptyToolSpanStats();
	const toolBatches = new Set<string>();
	const toolArgsHashes = new Set<string>();
	const seenIrcRecords = new Set<string>();
	const compactionEntryIds = new Set<string>();
	const activeEntryIds = activeBranchEntryIds(entries);

	let messages = 0;
	let firstTs: number | undefined;
	let lastTs: number | undefined;
	let maxLevelRank = 0;
	let maxLevel: InstrumentationLevel = "off";
	let currentTurn: TurnStat | undefined;
	let lifecycle: LifecycleStats | undefined;
	let context: ContextAttributionStats | undefined;
	let ircDelivery: IrcDeliveryStats | undefined;
	let taskState: TaskStateStats | undefined;

	const note = (ts: number) => {
		if (typeof ts !== "number") return;
		if (firstTs === undefined || ts < firstTs) firstTs = ts;
		if (lastTs === undefined || ts > lastTs) lastTs = ts;
	};
	const bumpLevel = (level: InstrumentationLevel) => {
		const rank = instrumentationRank(level);
		if (rank > maxLevelRank) {
			maxLevelRank = rank;
			maxLevel = level;
		}
	};

	for (const entry of entries) {
		if ("sequence" in entry && typeof entry.sequence === "number") {
			lifecycle ??= { transitions: 0, checkpoints: 0 };
			if (lifecycle.sequence) {
				lifecycle.sequence.entries += 1;
				lifecycle.sequence.last = entry.sequence;
				lifecycle.sequence.highest = Math.max(lifecycle.sequence.highest, entry.sequence);
			} else {
				lifecycle.sequence = {
					entries: 1,
					first: entry.sequence,
					last: entry.sequence,
					highest: entry.sequence,
				};
			}
			bumpLevel("basic");
		}

		if (entry.type === "session_lifecycle") {
			lifecycle ??= { transitions: 0, checkpoints: 0 };
			lifecycle.transitions += 1;
			lifecycle.latestState = {
				state: entry.state,
				reason: entry.reason,
				...(entry.sequence === undefined ? {} : { sequence: entry.sequence }),
			};
			const lifecycleLevel =
				"instrumentationLevel" in entry &&
				(entry.instrumentationLevel === "basic" ||
					entry.instrumentationLevel === "rich" ||
					entry.instrumentationLevel === "ultra")
					? entry.instrumentationLevel
					: "basic";
			bumpLevel(lifecycleLevel);
			continue;
		}

		if (entry.type === "session_checkpoint") {
			lifecycle ??= { transitions: 0, checkpoints: 0 };
			lifecycle.checkpoints += 1;
			lifecycle.latestCheckpoint = {
				id: entry.id,
				prefixSequence: entry.prefixSequence,
				...(entry.sequence === undefined ? {} : { sequence: entry.sequence }),
			};
			bumpLevel("basic");
			continue;
		}

		if (entry.type === "custom" && entry.customType === "irc:delivery-telemetry" && isRecord(entry.data)) {
			const data = entry.data;
			const level = data.level;
			const direction = data.direction;
			const messageId = data.messageId;
			const outcome = data.outcome;
			const payloadBytes = data.payloadBytes;
			if (
				(level === "rich" || level === "ultra") &&
				(direction === "sent" || direction === "received") &&
				typeof messageId === "string" &&
				(outcome === "injected" || outcome === "woken" || outcome === "revived" || outcome === "failed") &&
				typeof payloadBytes === "number"
			) {
				bumpLevel(level);
				const recordKey = `${direction}\u0000${messageId}`;
				if (!seenIrcRecords.has(recordKey)) {
					seenIrcRecords.add(recordKey);
					ircDelivery ??= {
						sent: {
							count: 0,
							payloadBytes: 0,
							outcomes: { injected: 0, woken: 0, revived: 0, failed: 0 },
						},
						received: {
							count: 0,
							payloadBytes: 0,
							outcomes: { injected: 0, woken: 0, revived: 0, failed: 0 },
						},
					};
					const directionStats = ircDelivery[direction];
					directionStats.count += 1;
					directionStats.payloadBytes += payloadBytes;
					directionStats.outcomes[outcome] += 1;

					if (typeof data.route === "string") {
						directionStats.routes ??= {};
						increment(directionStats.routes, data.route);
					}
					if (typeof data.revived === "boolean") {
						directionStats.revived = addBoolean(directionStats.revived, data.revived);
					}
					if (typeof data.deliveryLatencyMs === "number") {
						directionStats.deliveryLatencyMs = addNumber(
							directionStats.deliveryLatencyMs,
							data.deliveryLatencyMs,
						);
					}
					if (typeof data.recipientClass === "string") {
						directionStats.recipientClasses ??= {};
						increment(directionStats.recipientClasses, data.recipientClass);
					}
					if (typeof data.messageKind === "string") {
						directionStats.messageKinds ??= {};
						increment(directionStats.messageKinds, data.messageKind);
					}
				}
			}
			continue;
		}

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

			const snapshot = message.contextSnapshot;
			if (snapshot && typeof snapshot.promptTokens === "number" && typeof snapshot.nonMessageTokens === "number") {
				context ??= {
					snapshots: 0,
					promptTokens: { observations: 0, total: 0, max: 0 },
					nonMessageTokens: { observations: 0, total: 0, max: 0 },
				};
				context.snapshots += 1;
				context.promptTokens = addNumber(context.promptTokens, snapshot.promptTokens);
				context.nonMessageTokens = addNumber(context.nonMessageTokens, snapshot.nonMessageTokens);

				if (typeof snapshot.storedMessagesTokens === "number") {
					context.storedMessagesTokens = addNumber(context.storedMessagesTokens, snapshot.storedMessagesTokens);
				}
				if (typeof snapshot.tailTokens === "number") {
					context.tailTokens = addNumber(context.tailTokens, snapshot.tailTokens);
				}
				if (snapshot.promptTokensSource) {
					context.promptTokenSources ??= { provider: 0, estimate: 0 };
					context.promptTokenSources[snapshot.promptTokensSource] += 1;
				}
				const estimated = [
					["nonMessageTokens", snapshot.nonMessageTokensEstimated],
					["storedMessagesTokens", snapshot.storedMessagesTokensEstimated],
					["tailTokens", snapshot.tailTokensEstimated],
				] as const;
				for (const [category, value] of estimated) {
					if (value === undefined) continue;
					context.estimated ??= {};
					context.estimated[category] = addBoolean(context.estimated[category], value);
				}
				if (snapshot.compactionEntryId !== undefined) {
					if (!compactionEntryIds.has(snapshot.compactionEntryId)) {
						compactionEntryIds.add(snapshot.compactionEntryId);
						context.compactionEntries = compactionEntryIds.size;
						context.compactionEntryIds ??= [];
						context.compactionEntryIds.push(snapshot.compactionEntryId);
						if (context.compactionEntryIds.length > COMPACTION_ENTRY_ID_SAMPLE_LIMIT) {
							context.compactionEntryIds.shift();
						}
					}
					bumpLevel("ultra");
				} else if (
					snapshot.storedMessagesTokens !== undefined ||
					snapshot.tailTokens !== undefined ||
					snapshot.promptTokensSource !== undefined ||
					snapshot.nonMessageTokensEstimated !== undefined ||
					snapshot.storedMessagesTokensEstimated !== undefined ||
					snapshot.tailTokensEstimated !== undefined
				) {
					bumpLevel("rich");
				}
			}
			continue;
		}

		if (message.role === "user" || message.role === "developer") {
			note(message.timestamp);
			totals.userMessages += 1;
			continue;
		}

		if (message.role === "toolResult") {
			if (message.metrics) {
				accumulateToolSpan(message.metrics, toolSpans, toolBatches, toolArgsHashes);
			}

			if (message.toolName === "todo" && isRecord(message.details) && isRecord(message.details.telemetry)) {
				const telemetry = message.details.telemetry;
				const counts = telemetry.counts;
				const transitions = telemetry.transitions;
				if (
					typeof telemetry.operation === "string" &&
					isRecord(counts) &&
					isRecord(transitions) &&
					typeof counts.total === "number" &&
					typeof counts.open === "number" &&
					typeof counts.inProgress === "number" &&
					typeof counts.dropped === "number" &&
					typeof counts.completed === "number" &&
					typeof transitions.total === "number" &&
					typeof transitions.added === "number" &&
					typeof transitions.removed === "number" &&
					typeof transitions.toPending === "number" &&
					typeof transitions.toInProgress === "number" &&
					typeof transitions.toDropped === "number" &&
					typeof transitions.toCompleted === "number"
				) {
					taskState ??= {
						operations: 0,
						byOperation: {},
						transitions: {
							total: 0,
							added: 0,
							removed: 0,
							toPending: 0,
							toInProgress: 0,
							toDropped: 0,
							toCompleted: 0,
						},
					};
					taskState.operations += 1;
					increment(taskState.byOperation, telemetry.operation);
					if (activeEntryIds.has(entry.id)) {
						taskState.latest = {
							total: counts.total,
							open: counts.open,
							inProgress: counts.inProgress,
							dropped: counts.dropped,
							completed: counts.completed,
						};
					}
					taskState.transitions.total += transitions.total;
					taskState.transitions.added += transitions.added;
					taskState.transitions.removed += transitions.removed;
					taskState.transitions.toPending += transitions.toPending;
					taskState.transitions.toInProgress += transitions.toInProgress;
					taskState.transitions.toDropped += transitions.toDropped;
					taskState.transitions.toCompleted += transitions.toCompleted;
					bumpLevel("basic");
					if (telemetry.taskTransitions !== undefined) bumpLevel("ultra");
					else if (
						telemetry.before !== undefined ||
						telemetry.affectedPhases !== undefined ||
						telemetry.affectedTasks !== undefined
					) {
						bumpLevel("rich");
					}
				}
			}

			accumulateToolResult(message, {
				totals,
				tools,
				repeats,
				currentTurn,
				note,
				bumpLevel,
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
		...(lifecycle ? { lifecycle } : {}),
		...(context ? { context } : {}),
		...(toolSpans.calls > 0 ? { toolSpans } : {}),
		...(ircDelivery ? { ircDelivery } : {}),
		...(taskState ? { taskState } : {}),
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
		const fingerprint = metrics.argsDigest ?? metrics.argsHash;
		const namespace = metrics.argsDigest ? (metrics.argsDigestAlgorithm ?? "sha256-128") : "legacy-fnv1a-32";
		const key = `${message.toolName}\u0000${namespace}\u0000${fingerprint}`;
		const repeat = repeats.get(key) ?? {
			tool: message.toolName,
			argsHash: fingerprint,
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
