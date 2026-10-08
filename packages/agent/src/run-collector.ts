/**
 * Per-invocation run aggregator. Buffers per-chat and per-tool records as the
 * loop executes and folds them into a single {@link AgentRunSummary} +
 * {@link AgentRunCoverage} value at the end.
 *
 * One collector lives on each {@link AgentTelemetry} handle, which is
 * constructed once per `agentLoop` invocation in {@link resolveTelemetry}.
 * Collector lookups use the live `Span` as a `WeakMap` key — bounded memory,
 * no cross-invoke leakage.
 *
 * The collector is fed exclusively by helpers in `./telemetry.ts`. Loop
 * authors do not interact with it directly except via the public
 * `recordSkippedTool` helper used for the two skip paths that bypass spans
 * entirely (pre-run interrupt and the tail-sweep for tool calls that never
 * produced a result message).
 */

import type { Span } from "@opentelemetry/api";
import type { AssistantMessage, Model, StopReason } from "@veyyon/ai";

/** Terminal status reported by an `execute_tool` span. */
export type ToolStatus = "ok" | "error" | "skipped" | "blocked" | "timeout" | "aborted";

/** Raw record for a single `chat` step, finalized by `finishChatSpan`. */
export interface ChatRecord {
	readonly stepNumber: number;
	readonly model: string;
	readonly provider: string;
	readonly stopReason: StopReason | undefined;
	readonly latencyMs: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cachedInputTokens: number;
	readonly cacheWriteTokens: number;
	readonly reasoningOutputTokens: number;
	readonly totalTokens: number;
	readonly costUsd: number | undefined;
	readonly costUnavailableReason: string | undefined;
	readonly errorType: string | undefined;
}

/** Raw record for a single `execute_tool` invocation. */
export interface ToolRecord {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly status: ToolStatus;
	readonly latencyMs: number;
	readonly errorType: string | undefined;
}

/** Per-tool counters surfaced under {@link AgentRunSummary.tools.byName}. */
export interface ToolCounters {
	readonly total: number;
	readonly ok: number;
	readonly error: number;
	readonly skipped: number;
	readonly blocked: number;
	readonly timeout: number;
	readonly aborted: number;
	readonly totalLatencyMs: number;
}

/**
 * Run-level rollup returned in the `agent_end` event and passed to
 * {@link AgentTelemetryConfig.onRunEnd}. Pure aggregation — no references to
 * spans, no callbacks, no live state. Safe to persist / diff / assert.
 */
export interface AgentRunSummary {
	readonly chats: {
		readonly total: number;
		/** Bucketed by raw {@link StopReason}; absent reasons omitted. */
		readonly byStopReason: Readonly<Record<string, number>>;
		readonly totalLatencyMs: number;
	};
	readonly tools: {
		readonly total: number;
		readonly ok: number;
		readonly error: number;
		readonly skipped: number;
		readonly blocked: number;
		readonly timeout: number;
		readonly aborted: number;
		readonly totalLatencyMs: number;
		/** Per-tool-name counters; keys sorted by name on snapshot. */
		readonly byName: Readonly<Record<string, ToolCounters>>;
	};
	readonly usage: {
		readonly inputTokens: number;
		readonly outputTokens: number;
		readonly cachedInputTokens: number;
		readonly cacheWriteTokens: number;
		readonly reasoningOutputTokens: number;
		readonly totalTokens: number;
	};
	readonly cost: {
		readonly estimatedUsd: number;
		/** Sorted, deduped. */
		readonly unavailableReasons: readonly string[];
	};
	readonly errors: {
		readonly total: number;
		readonly byType: Readonly<Record<string, number>>;
	};
	readonly stepCount: number;
}

/**
 * Coverage rollup: registered-vs-invoked across the run. All arrays are
 * sorted ascending and deduped so the value is stable for diffing.
 */
export interface AgentRunCoverage {
	readonly toolsAvailable: readonly string[];
	readonly toolsInvoked: readonly string[];
	readonly toolsUnused: readonly string[];
	readonly modelsUsed: readonly string[];
	readonly providersUsed: readonly string[];
}

interface ChatStart {
	readonly stepNumber: number;
	readonly startedAtMs: number;
	readonly model: string;
	readonly provider: string;
}

interface ToolStart {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly startedAtMs: number;
}

/**
 * Per-invocation event buffer. Constructed unconditionally inside
 * {@link resolveTelemetry}; cost is one allocation per `agentLoop` call.
 *
 * Methods are intentionally non-throwing — telemetry must never turn a
 * successful agent run into a failed one. WeakMap keys keep span-state
 * lookups bounded; if a finish path is somehow reached without a matching
 * begin (provider crash, tracer swap mid-run), the corresponding record is
 * still emitted with `latencyMs: 0` rather than throwing.
 */
const kChatStart = Symbol("agent.run-collector.chatStart");
const kToolStart = Symbol("agent.run-collector.toolStart");
type SpanWithChatStart = Span & { [kChatStart]?: ChatStart };
type SpanWithToolStart = Span & { [kToolStart]?: ToolStart };

export class AgentRunCollector {
	readonly #chats: ChatRecord[] = [];
	readonly #tools: ToolRecord[] = [];
	readonly #availableTools = new Set<string>();
	readonly #invokedTools = new Set<string>();
	readonly #modelsUsed = new Set<string>();
	readonly #providersUsed = new Set<string>();
	#runEnded = false;

	/** True once `markRunEnded()` has been called for this invocation. */
	get runEnded(): boolean {
		return this.#runEnded;
	}

	/**
	 * Mark this run as logically ended. Callers use this to coordinate the
	 * `onRunEnd` hook between the success path (fires inside
	 * `buildAgentEndEvent`, before `stream.end()`) and the error path (fires
	 * inside `finishInvokeAgentSpan`'s finally). Idempotent — returns `true`
	 * the first time, `false` on subsequent calls.
	 */
	markRunEnded(): boolean {
		if (this.#runEnded) return false;
		this.#runEnded = true;
		return true;
	}

	/** Record the tool names exposed on a single chat step. */
	noteAvailableTools(tools: readonly { readonly name: string }[] | undefined): void {
		if (!tools) return;
		for (const tool of tools) this.#availableTools.add(tool.name);
	}

	beginChat(
		span: Span,
		init: { readonly stepNumber: number; readonly model: Model; readonly provider?: string },
	): void {
		const provider = init.provider ?? init.model.provider;
		(span as SpanWithChatStart)[kChatStart] = {
			stepNumber: init.stepNumber,
			startedAtMs: performance.now(),
			model: init.model.id,
			provider,
		};
		this.#modelsUsed.add(init.model.id);
		if (provider) this.#providersUsed.add(provider);
	}

	endChat(
		span: Span,
		message: AssistantMessage,
		fields: {
			readonly costUsd: number | undefined;
			readonly costUnavailableReason: string | undefined;
		},
	): void {
		const start = (span as SpanWithChatStart)[kChatStart];
		(span as SpanWithChatStart)[kChatStart] = undefined;
		const usage = message.usage;
		// Public surface: `inputTokens` is the total cost-bearing input the
		// provider charged for, so it must include cache_read + cache_write.
		// The per-bucket fields below preserve the breakdown for callers that
		// want it. `aggregateAgentRunSummaries` sums each field independently
		// and never re-derives `inputTokens` from the buckets, so this stays
		// consistent across run merges.
		const inputBase = usage?.input ?? 0;
		const cachedInputTokens = usage?.cacheRead ?? 0;
		const cacheWriteTokens = usage?.cacheWrite ?? 0;
		const inputTokens = inputBase + cachedInputTokens + cacheWriteTokens;
		const outputTokens = usage?.output ?? 0;
		const reasoningOutputTokens = usage?.reasoningTokens ?? 0;
		const totalTokens = usage?.totalTokens ?? inputTokens + outputTokens;
		this.#chats.push({
			stepNumber: start?.stepNumber ?? -1,
			model: start?.model ?? message.model,
			provider: start?.provider ?? message.provider,
			stopReason: message.stopReason,
			latencyMs: start ? Math.max(0, performance.now() - start.startedAtMs) : 0,
			inputTokens,
			outputTokens,
			cachedInputTokens,
			cacheWriteTokens,
			reasoningOutputTokens,
			totalTokens,
			costUsd: fields.costUsd,
			costUnavailableReason: fields.costUnavailableReason,
			errorType: message.stopReason === "error" || message.stopReason === "aborted" ? message.stopReason : undefined,
		});
	}

	/**
	 * Stamp the chat span as failed without a finalized AssistantMessage. Used
	 * by the `catch` arm of `streamAssistantResponse` so error chats still
	 * appear in the run summary.
	 */
	failChat(span: Span, fields: { readonly errorType: string }): void {
		const start = (span as SpanWithChatStart)[kChatStart];
		(span as SpanWithChatStart)[kChatStart] = undefined;
		this.#chats.push({
			stepNumber: start?.stepNumber ?? -1,
			model: start?.model ?? "",
			provider: start?.provider ?? "",
			stopReason: "error",
			latencyMs: start ? Math.max(0, performance.now() - start.startedAtMs) : 0,
			inputTokens: 0,
			outputTokens: 0,
			cachedInputTokens: 0,
			cacheWriteTokens: 0,
			reasoningOutputTokens: 0,
			totalTokens: 0,
			costUsd: undefined,
			costUnavailableReason: undefined,
			errorType: fields.errorType,
		});
	}

	beginTool(span: Span, init: { readonly toolCallId: string; readonly toolName: string }): void {
		(span as SpanWithToolStart)[kToolStart] = {
			toolCallId: init.toolCallId,
			toolName: init.toolName,
			startedAtMs: performance.now(),
		};
		this.#invokedTools.add(init.toolName);
	}

	endTool(span: Span, fields: { readonly status: ToolStatus; readonly errorType: string | undefined }): void {
		const start = (span as SpanWithToolStart)[kToolStart];
		(span as SpanWithToolStart)[kToolStart] = undefined;
		this.#tools.push({
			toolCallId: start?.toolCallId ?? "",
			toolName: start?.toolName ?? "",
			status: fields.status,
			latencyMs: start ? Math.max(0, performance.now() - start.startedAtMs) : 0,
			errorType: fields.errorType,
		});
	}

	/**
	 * Record a tool that never produced a span — pre-run interrupt or tail
	 * sweep. The LLM still asked for it, so it counts toward
	 * {@link AgentRunCoverage.toolsInvoked}.
	 */
	recordOrphanTool(record: {
		readonly toolCallId: string;
		readonly toolName: string;
		readonly status: ToolStatus;
	}): void {
		this.#invokedTools.add(record.toolName);
		this.#tools.push({
			toolCallId: record.toolCallId,
			toolName: record.toolName,
			status: record.status,
			latencyMs: 0,
			errorType: record.status === "ok" ? undefined : `tool_${record.status}`,
		});
	}

	/** Build the immutable summary value from buffered records. */
	snapshot(opts: { readonly stepCount: number }): {
		readonly summary: AgentRunSummary;
		readonly coverage: AgentRunCoverage;
	} {
		return {
			summary: this.#buildSummary(opts.stepCount),
			coverage: this.#buildCoverage(),
		};
	}

	#buildSummary(stepCount: number): AgentRunSummary {
		const tally = new RunSummaryTally();
		for (const chat of this.#chats) tally.addChat(chat);
		for (const tool of this.#tools) tally.addTool(tool);
		return tally.summary(stepCount);
	}

	#buildCoverage(): AgentRunCoverage {
		const toolsAvailable = Array.from(this.#availableTools).sort();
		const toolsInvoked = Array.from(this.#invokedTools).sort();
		const toolsUnused = toolsAvailable.filter(name => !this.#invokedTools.has(name));
		// Tools the LLM invoked that were never declared on any request remain
		// present in `toolsInvoked` but absent from `toolsAvailable`. Callers
		// diff to detect this case if they care.
		return {
			toolsAvailable,
			toolsInvoked,
			toolsUnused,
			modelsUsed: Array.from(this.#modelsUsed).sort(),
			providersUsed: Array.from(this.#providersUsed).sort(),
		};
	}
}

type ToolTally = { -readonly [K in keyof ToolCounters]: ToolCounters[K] };
type UsageTally = { -readonly [K in keyof AgentRunSummary["usage"]]: number };

const NO_TOOL_COUNTERS: ToolCounters = Object.freeze({
	total: 0,
	ok: 0,
	error: 0,
	skipped: 0,
	blocked: 0,
	timeout: 0,
	aborted: 0,
	totalLatencyMs: 0,
});

/**
 * Running totals an {@link AgentRunSummary} is built from: the buffered records of one run, or the summaries of
 * several. Keyed tallies are Maps, so a tool, stop reason or error type named like an `Object.prototype` member
 * (`__proto__`, `constructor`) is counted under its own name.
 */
class RunSummaryTally {
	#chatTotal = 0;
	#chatLatencyMs = 0;
	readonly #byStopReason = new Map<string, number>();
	readonly #tools: ToolTally = { ...NO_TOOL_COUNTERS };
	readonly #byName = new Map<string, ToolTally>();
	readonly #usage: UsageTally = {
		inputTokens: 0,
		outputTokens: 0,
		cachedInputTokens: 0,
		cacheWriteTokens: 0,
		reasoningOutputTokens: 0,
		totalTokens: 0,
	};
	#estimatedUsd = 0;
	readonly #unavailableReasons = new Set<string>();
	readonly #errorsByType = new Map<string, number>();
	#errorsTotal = 0;

	addChat(chat: ChatRecord): void {
		this.#chatTotal += 1;
		this.#chatLatencyMs += chat.latencyMs;
		this.#addUsage(chat);
		if (chat.stopReason) this.#byStopReason.set(chat.stopReason, (this.#byStopReason.get(chat.stopReason) ?? 0) + 1);
		if (chat.costUsd != null) this.#estimatedUsd += chat.costUsd;
		if (chat.costUnavailableReason) this.#unavailableReasons.add(chat.costUnavailableReason);
		if (chat.errorType) this.#countError(chat.errorType);
	}

	addTool(tool: ToolRecord): void {
		countToolRecord(this.#tools, tool);
		countToolRecord(this.#nameTally(tool.toolName), tool);
		if (tool.errorType) this.#countError(tool.errorType);
	}

	addSummary(summary: AgentRunSummary): void {
		this.#chatTotal += summary.chats.total;
		this.#chatLatencyMs += summary.chats.totalLatencyMs;
		for (const [reason, count] of Object.entries(summary.chats.byStopReason)) {
			this.#byStopReason.set(reason, (this.#byStopReason.get(reason) ?? 0) + count);
		}
		addToolCounters(this.#tools, summary.tools);
		for (const [name, counters] of Object.entries(summary.tools.byName)) {
			addToolCounters(this.#nameTally(name), counters);
		}
		this.#addUsage(summary.usage);
		this.#estimatedUsd += summary.cost.estimatedUsd;
		for (const reason of summary.cost.unavailableReasons) this.#unavailableReasons.add(reason);
		for (const [type, count] of Object.entries(summary.errors.byType)) {
			this.#errorsByType.set(type, (this.#errorsByType.get(type) ?? 0) + count);
		}
		this.#errorsTotal += summary.errors.total;
	}

	summary(stepCount: number): AgentRunSummary {
		return {
			chats: {
				total: this.#chatTotal,
				byStopReason: sortedRecord(this.#byStopReason),
				totalLatencyMs: this.#chatLatencyMs,
			},
			tools: { ...this.#tools, byName: sortedRecord(this.#byName) },
			usage: { ...this.#usage },
			cost: {
				estimatedUsd: this.#estimatedUsd,
				unavailableReasons: Array.from(this.#unavailableReasons).sort(),
			},
			errors: { total: this.#errorsTotal, byType: sortedRecord(this.#errorsByType) },
			stepCount,
		};
	}

	#addUsage(usage: AgentRunSummary["usage"]): void {
		const total = this.#usage;
		total.inputTokens += usage.inputTokens;
		total.outputTokens += usage.outputTokens;
		total.cachedInputTokens += usage.cachedInputTokens;
		total.cacheWriteTokens += usage.cacheWriteTokens;
		total.reasoningOutputTokens += usage.reasoningOutputTokens;
		total.totalTokens += usage.totalTokens;
	}

	#nameTally(name: string): ToolTally {
		let tally = this.#byName.get(name);
		if (tally === undefined) {
			tally = { ...NO_TOOL_COUNTERS };
			this.#byName.set(name, tally);
		}
		return tally;
	}

	#countError(type: string): void {
		this.#errorsByType.set(type, (this.#errorsByType.get(type) ?? 0) + 1);
		this.#errorsTotal += 1;
	}
}

function countToolRecord(tally: ToolTally, tool: ToolRecord): void {
	tally.total += 1;
	tally[tool.status] += 1;
	tally.totalLatencyMs += tool.latencyMs;
}

function addToolCounters(tally: ToolTally, counters: ToolCounters): void {
	tally.total += counters.total;
	tally.ok += counters.ok;
	tally.error += counters.error;
	tally.skipped += counters.skipped;
	tally.blocked += counters.blocked;
	tally.timeout += counters.timeout;
	tally.aborted += counters.aborted;
	tally.totalLatencyMs += counters.totalLatencyMs;
}

/**
 * Fold multiple per-run summaries into one. Pure aggregation — useful when a
 * caller (verify pass, benchmark harness) drives the agent loop N times and
 * needs a single rollup across all invocations.
 *
 * Counters sum element-wise. Sets (cost reasons, error types, per-tool
 * counters) merge by key. Numeric totals sum. The output is in the same
 * shape as a single `AgentRunSummary`, so all dashboards and persistence
 * layers handle it uniformly.
 */
export function aggregateAgentRunSummaries(summaries: readonly AgentRunSummary[]): AgentRunSummary {
	if (summaries.length === 0) return EMPTY_SUMMARY;
	if (summaries.length === 1) return summaries[0];
	const tally = new RunSummaryTally();
	let stepCount = 0;
	for (const summary of summaries) {
		tally.addSummary(summary);
		stepCount += summary.stepCount;
	}
	return tally.summary(stepCount);
}

/** Union-merge multiple coverage values, preserving the sorted+deduped invariant. */
export function aggregateAgentRunCoverage(coverages: readonly AgentRunCoverage[]): AgentRunCoverage {
	if (coverages.length === 0) return EMPTY_COVERAGE;
	if (coverages.length === 1) return coverages[0];
	const available = new Set<string>();
	const invoked = new Set<string>();
	const models = new Set<string>();
	const providers = new Set<string>();
	for (const c of coverages) {
		for (const t of c.toolsAvailable) available.add(t);
		for (const t of c.toolsInvoked) invoked.add(t);
		for (const m of c.modelsUsed) models.add(m);
		for (const p of c.providersUsed) providers.add(p);
	}
	const toolsAvailable = Array.from(available).sort();
	return {
		toolsAvailable,
		toolsInvoked: Array.from(invoked).sort(),
		toolsUnused: toolsAvailable.filter(name => !invoked.has(name)),
		modelsUsed: Array.from(models).sort(),
		providersUsed: Array.from(providers).sort(),
	};
}

const EMPTY_SUMMARY: AgentRunSummary = Object.freeze({
	chats: Object.freeze({ total: 0, byStopReason: Object.freeze({}), totalLatencyMs: 0 }),
	tools: Object.freeze({
		total: 0,
		ok: 0,
		error: 0,
		skipped: 0,
		blocked: 0,
		timeout: 0,
		aborted: 0,
		totalLatencyMs: 0,
		byName: Object.freeze({}),
	}),
	usage: Object.freeze({
		inputTokens: 0,
		outputTokens: 0,
		cachedInputTokens: 0,
		cacheWriteTokens: 0,
		reasoningOutputTokens: 0,
		totalTokens: 0,
	}),
	cost: Object.freeze({ estimatedUsd: 0, unavailableReasons: Object.freeze([]) as readonly string[] }),
	errors: Object.freeze({ total: 0, byType: Object.freeze({}) }),
	stepCount: 0,
}) as AgentRunSummary;

const EMPTY_COVERAGE: AgentRunCoverage = Object.freeze({
	toolsAvailable: Object.freeze([]) as readonly string[],
	toolsInvoked: Object.freeze([]) as readonly string[],
	toolsUnused: Object.freeze([]) as readonly string[],
	modelsUsed: Object.freeze([]) as readonly string[],
	providersUsed: Object.freeze([]) as readonly string[],
}) as AgentRunCoverage;

/** Empty `AgentRunSummary` constant. Exported for tests and default-initializers. */
export function emptyAgentRunSummary(): AgentRunSummary {
	return EMPTY_SUMMARY;
}

/** Empty `AgentRunCoverage` constant. Exported for tests and default-initializers. */
export function emptyAgentRunCoverage(): AgentRunCoverage {
	return EMPTY_COVERAGE;
}

/**
 * Distinguishable error class thrown when `beforeToolCall` returns
 * `{ block: true }`. Lets the catch arm of `runTool` set the terminal status
 * on the execute_tool span to `"blocked"` instead of conflating with a real
 * tool exception.
 */
export class ToolCallBlockedError extends Error {
	override readonly name = "ToolCallBlockedError";
	constructor(reason?: string) {
		super(reason ?? "Tool execution was blocked");
	}
}

/**
 * `counts` as an object whose own keys are in ascending order. `Object.fromEntries` defines each key, so a
 * `__proto__` key stays an own key instead of replacing the prototype.
 */
function sortedRecord<V>(counts: ReadonlyMap<string, V>): Record<string, V> {
	return Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : 1)));
}
