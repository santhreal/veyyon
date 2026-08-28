import type { Span } from "@opentelemetry/api";
import type { AssistantMessage, Model, StopReason } from "@veyyon/ai";

export type ToolStatus = "ok" | "error" | "skipped" | "blocked" | "timeout" | "aborted";

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

export interface ToolRecord {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly status: ToolStatus;
	readonly latencyMs: number;
	readonly errorType: string | undefined;
}

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

export interface AgentRunSummary {
	readonly chats: {
		readonly total: number;
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
		readonly unavailableReasons: readonly string[];
	};
	readonly errors: {
		readonly total: number;
		readonly byType: Readonly<Record<string, number>>;
	};
	readonly stepCount: number;
}

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

	get runEnded(): boolean {
		return this.#runEnded;
	}

	markRunEnded(): boolean {
		if (this.#runEnded) return false;
		this.#runEnded = true;
		return true;
	}

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
		// inputTokens includes base + cache read + cache write for total charged input.
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
		const byStopReason: Record<string, number> = {};
		let chatLatency = 0;
		let inputTokens = 0;
		let outputTokens = 0;
		let cachedInputTokens = 0;
		let cacheWriteTokens = 0;
		let reasoningOutputTokens = 0;
		let totalTokens = 0;
		let estimatedUsd = 0;
		const unavailableReasons = new Set<string>();
		const errorsByType: Record<string, number> = {};

		for (const chat of this.#chats) {
			chatLatency += chat.latencyMs;
			inputTokens += chat.inputTokens;
			outputTokens += chat.outputTokens;
			cachedInputTokens += chat.cachedInputTokens;
			cacheWriteTokens += chat.cacheWriteTokens;
			reasoningOutputTokens += chat.reasoningOutputTokens;
			totalTokens += chat.totalTokens;
			if (chat.stopReason) byStopReason[chat.stopReason] = (byStopReason[chat.stopReason] ?? 0) + 1;
			if (chat.costUsd != null) estimatedUsd += chat.costUsd;
			if (chat.costUnavailableReason) unavailableReasons.add(chat.costUnavailableReason);
			if (chat.errorType) errorsByType[chat.errorType] = (errorsByType[chat.errorType] ?? 0) + 1;
		}

		const byName: Record<string, ToolCounters> = {};
		const counts: Record<ToolStatus, number> = {
			ok: 0,
			error: 0,
			skipped: 0,
			blocked: 0,
			timeout: 0,
			aborted: 0,
		};
		let toolLatency = 0;
		for (const tool of this.#tools) {
			counts[tool.status] += 1;
			toolLatency += tool.latencyMs;
			const existing = byName[tool.toolName] ?? {
				total: 0,
				ok: 0,
				error: 0,
				skipped: 0,
				blocked: 0,
				timeout: 0,
				aborted: 0,
				totalLatencyMs: 0,
			};
			byName[tool.toolName] = {
				total: existing.total + 1,
				ok: existing.ok + (tool.status === "ok" ? 1 : 0),
				error: existing.error + (tool.status === "error" ? 1 : 0),
				skipped: existing.skipped + (tool.status === "skipped" ? 1 : 0),
				blocked: existing.blocked + (tool.status === "blocked" ? 1 : 0),
				timeout: existing.timeout + (tool.status === "timeout" ? 1 : 0),
				aborted: existing.aborted + (tool.status === "aborted" ? 1 : 0),
				totalLatencyMs: existing.totalLatencyMs + tool.latencyMs,
			};
			if (tool.errorType) errorsByType[tool.errorType] = (errorsByType[tool.errorType] ?? 0) + 1;
		}

		let errorTotal = 0;
		for (const v of Object.values(errorsByType)) errorTotal += v;

		return {
			chats: {
				total: this.#chats.length,
				byStopReason: sortedRecord(byStopReason),
				totalLatencyMs: chatLatency,
			},
			tools: {
				total: this.#tools.length,
				ok: counts.ok,
				error: counts.error,
				skipped: counts.skipped,
				blocked: counts.blocked,
				timeout: counts.timeout,
				aborted: counts.aborted,
				totalLatencyMs: toolLatency,
				byName: sortedRecord(byName),
			},
			usage: {
				inputTokens,
				outputTokens,
				cachedInputTokens,
				cacheWriteTokens,
				reasoningOutputTokens,
				totalTokens,
			},
			cost: {
				estimatedUsd,
				unavailableReasons: Array.from(unavailableReasons).sort(),
			},
			errors: {
				total: errorTotal,
				byType: sortedRecord(errorsByType),
			},
			stepCount,
		};
	}

	#buildCoverage(): AgentRunCoverage {
		const toolsAvailable = Array.from(this.#availableTools).sort();
		const toolsInvoked = Array.from(this.#invokedTools).sort();
		const toolsUnused = toolsAvailable.filter(name => !this.#invokedTools.has(name));
		return {
			toolsAvailable,
			toolsInvoked,
			toolsUnused,
			modelsUsed: Array.from(this.#modelsUsed).sort(),
			providersUsed: Array.from(this.#providersUsed).sort(),
		};
	}
}

/** Fold multiple per-run summaries into one. */
export function aggregateAgentRunSummaries(summaries: readonly AgentRunSummary[]): AgentRunSummary {
	if (summaries.length === 0) return EMPTY_SUMMARY;
	if (summaries.length === 1) return summaries[0];

	let chatTotal = 0;
	let chatLatency = 0;
	const byStopReason: Record<string, number> = {};

	let toolTotal = 0;
	let toolOk = 0;
	let toolError = 0;
	let toolSkipped = 0;
	let toolBlocked = 0;
	let toolTimeout = 0;
	let toolAborted = 0;
	let toolLatency = 0;
	const byName: Record<string, ToolCounters> = {};

	let inputTokens = 0;
	let outputTokens = 0;
	let cachedInputTokens = 0;
	let cacheWriteTokens = 0;
	let reasoningOutputTokens = 0;
	let totalTokens = 0;

	let estimatedUsd = 0;
	const unavailableReasons = new Set<string>();

	const errorsByType: Record<string, number> = {};
	let errorsTotal = 0;
	let stepCount = 0;

	for (const s of summaries) {
		chatTotal += s.chats.total;
		chatLatency += s.chats.totalLatencyMs;
		for (const [reason, count] of Object.entries(s.chats.byStopReason)) {
			byStopReason[reason] = (byStopReason[reason] ?? 0) + count;
		}

		toolTotal += s.tools.total;
		toolOk += s.tools.ok;
		toolError += s.tools.error;
		toolSkipped += s.tools.skipped;
		toolBlocked += s.tools.blocked;
		toolTimeout += s.tools.timeout;
		toolAborted += s.tools.aborted;
		toolLatency += s.tools.totalLatencyMs;
		for (const [name, counters] of Object.entries(s.tools.byName)) {
			const existing = byName[name];
			byName[name] = existing
				? {
						total: existing.total + counters.total,
						ok: existing.ok + counters.ok,
						error: existing.error + counters.error,
						skipped: existing.skipped + counters.skipped,
						blocked: existing.blocked + counters.blocked,
						timeout: existing.timeout + counters.timeout,
						aborted: existing.aborted + counters.aborted,
						totalLatencyMs: existing.totalLatencyMs + counters.totalLatencyMs,
					}
				: counters;
		}

		inputTokens += s.usage.inputTokens;
		outputTokens += s.usage.outputTokens;
		cachedInputTokens += s.usage.cachedInputTokens;
		cacheWriteTokens += s.usage.cacheWriteTokens;
		reasoningOutputTokens += s.usage.reasoningOutputTokens;
		totalTokens += s.usage.totalTokens;

		estimatedUsd += s.cost.estimatedUsd;
		for (const r of s.cost.unavailableReasons) unavailableReasons.add(r);

		for (const [type, count] of Object.entries(s.errors.byType)) {
			errorsByType[type] = (errorsByType[type] ?? 0) + count;
		}
		errorsTotal += s.errors.total;
		stepCount += s.stepCount;
	}

	return {
		chats: { total: chatTotal, byStopReason: sortedRecord(byStopReason), totalLatencyMs: chatLatency },
		tools: {
			total: toolTotal,
			ok: toolOk,
			error: toolError,
			skipped: toolSkipped,
			blocked: toolBlocked,
			timeout: toolTimeout,
			aborted: toolAborted,
			totalLatencyMs: toolLatency,
			byName: sortedRecord(byName),
		},
		usage: { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens, reasoningOutputTokens, totalTokens },
		cost: { estimatedUsd, unavailableReasons: Array.from(unavailableReasons).sort() },
		errors: { total: errorsTotal, byType: sortedRecord(errorsByType) },
		stepCount,
	};
}

/** Union-merge multiple coverage values. */
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

export function emptyAgentRunSummary(): AgentRunSummary {
	return EMPTY_SUMMARY;
}

export function emptyAgentRunCoverage(): AgentRunCoverage {
	return EMPTY_COVERAGE;
}

/** Error thrown when a tool call is blocked before execution. */
export class ToolCallBlockedError extends Error {
	override readonly name = "ToolCallBlockedError";
	constructor(reason?: string) {
		super(reason ?? "Tool execution was blocked");
	}
}

function sortedRecord<V>(record: Record<string, V>): Record<string, V> {
	const out: Record<string, V> = {};
	for (const key of Object.keys(record).sort()) out[key] = record[key];
	return out;
}
