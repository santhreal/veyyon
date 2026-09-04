/**
 * Session instrumentation — one owner for how densely a run records what its
 * tool calls AND model turns did, so a stored session can be studied after the
 * fact (latency hot spots, tool cost, token weight, turn cadence, throughput).
 *
 * The richness is graded, not a bare on/off. `off` changes nothing (no metrics
 * are attached, existing behavior). Each higher level adds strictly more fields
 * and strictly more cost: `basic` is wall-clock only (a subtraction, free);
 * `rich` adds the result's byte/token weight (one tokenizer pass) and per-turn
 * throughput; `ultra` captures everything we could want for study, including an
 * args fingerprint and cache/provider detail.
 *
 * This file is the single place that decides which fields each level fills.
 * The agent loop measures the raw timings and hands them here; nothing else
 * branches on the level. Keeping the level→fields mapping in one pure function
 * is what makes "add a field to the ultra tier" a one-line change with one
 * test, instead of a scattered set of `if (level === ...)` checks.
 */

import type { Usage } from "@veyyon/catalog/types";
import {
	type AssistantTurnMetrics,
	type AssistantTurnRequest,
	type AssistantTurnStatus,
	INSTRUMENTATION_LEVELS,
	type InstrumentationLevel,
	type ToolCallMetrics,
	type ToolCallStatus,
} from "@veyyon/model/instrumentation";
import type { ImageContent, TextContent } from "./types";

export {
	type AssistantTurnMetrics,
	type AssistantTurnRequest,
	type AssistantTurnStatus,
	INSTRUMENTATION_LEVELS,
	type InstrumentationLevel,
	type ToolCallMetrics,
	type ToolCallStatus,
};

/** Numeric rank of a level (`off` = 0). Unknown strings rank as `off`. */
export function instrumentationRank(level: InstrumentationLevel | undefined): number {
	const index = level === undefined ? 0 : INSTRUMENTATION_LEVELS.indexOf(level);
	return index < 0 ? 0 : index;
}

/** Whether `level` is at least `minimum` in the richness order. */
export function atLeast(level: InstrumentationLevel | undefined, minimum: InstrumentationLevel): boolean {
	return instrumentationRank(level) >= instrumentationRank(minimum);
}

/**
 * Persisted telemetry families governed by {@link InstrumentationLevel}.
 *
 * This is deliberately a closed vocabulary: a new persisted family must be
 * added here and assigned a minimum level below before any recorder can emit it.
 */
export type SessionTelemetryCategory =
	| "lifecycle"
	| "context-breakdown"
	| "tool-span"
	| "model-turn"
	| "model-request"
	| "agent-communication"
	| "goal-verification";

export type SessionTelemetryDetail = "none" | Exclude<InstrumentationLevel, "off">;

/**
 * Canonical minimum level for every persisted telemetry family.
 *
 * | Category | off | basic | rich | ultra |
 * | --- | --- | --- | --- | --- |
 * | lifecycle | none | basic | rich | ultra |
 * | context-breakdown | none | none | rich | ultra |
 * | tool-span | none | basic | rich | ultra |
 * | model-turn | none | basic | rich | ultra |
 * | model-request | none | basic | rich | ultra |
 * | agent-communication | none | none | rich | ultra |
 * | goal-verification | none | basic | rich | ultra |
 *
 * Permission is only the first boundary. Persistors must still store structured,
 * redacted data: raw secrets and unredacted tool arguments are never permitted
 * at any level.
 */
export const SESSION_TELEMETRY_POLICY = {
	lifecycle: "basic",
	"context-breakdown": "rich",
	"tool-span": "basic",
	"model-turn": "basic",
	"model-request": "basic",
	"agent-communication": "rich",
	"goal-verification": "basic",
} as const satisfies Record<SessionTelemetryCategory, Exclude<InstrumentationLevel, "off">>;

/**
 * Payload detail permitted for a category at `level`.
 *
 * Unknown runtime values follow {@link instrumentationRank} and are treated as
 * `off`, preserving the existing fail-closed behavior for malformed configs.
 */
export function sessionTelemetryDetail(
	level: InstrumentationLevel | undefined,
	category: SessionTelemetryCategory,
): SessionTelemetryDetail {
	const rank = instrumentationRank(level);
	if (rank < instrumentationRank(SESSION_TELEMETRY_POLICY[category])) return "none";
	if (level === "basic" || level === "rich" || level === "ultra") return level;
	return "none";
}

/** Whether a telemetry family may be persisted at `level`. */
export function allowsSessionTelemetry(
	level: InstrumentationLevel | undefined,
	category: SessionTelemetryCategory,
): boolean {
	return sessionTelemetryDetail(level, category) !== "none";
}

/**
 * Raw materials the loop hands to {@link captureToolCallMetrics}. The loop
 * always fills the cheap timing fields; the capture function decides which of
 * them survive into the record and whether to compute the expensive ones
 * (token count, args hash) based on the level.
 */
export interface ToolCallMetricsInput {
	level: InstrumentationLevel;
	startedAt: number;
	endedAt: number;
	queuedAt?: number;
	concurrency?: "shared" | "exclusive";
	batchId?: string;
	batchIndex?: number;
	batchSize?: number;
	status: ToolCallStatus;
	interruptible?: boolean;
	signalAborted?: boolean;
	/** Whether the tool explicitly marked this successful result as contextually useless. */
	useless?: boolean;
	resultContent?: readonly (TextContent | ImageContent)[];
	args?: Record<string, unknown>;
	/**
	 * Token counter used at `rich`+ to weigh the result. Injected so this module
	 * stays free of the native tokenizer dependency; when absent, `resultTokens`
	 * is left unset rather than guessed.
	 */
	countTokens?: (text: string) => number;
}

const textEncoder = new TextEncoder();

function utf8Bytes(text: string): number {
	return textEncoder.encode(text).length;
}

/**
 * Stable 128-bit SHA-256 prefix. The previous 32-bit FNV fingerprint collided
 * at study-scale cardinalities and could label distinct calls as identical.
 */
function stableArgsDigest(text: string): string {
	return new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 32);
}

/** Legacy 32-bit fingerprint retained so existing readers keep their field contract. */
function legacyArgsHash(text: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Build the level-gated metrics record for one tool call, or `undefined` at
 * `off`. This is the single mapping from level to captured fields: the `basic`
 * block is always filled, `rich` adds scheduling and output weight, `ultra`
 * adds the args fingerprint and signal state. Expensive work (tokenizing the
 * result, serializing+hashing args) runs only at the tier that keeps it.
 */
export function captureToolCallMetrics(input: ToolCallMetricsInput): ToolCallMetrics | undefined {
	const { level } = input;
	if (level === "off") return undefined;

	const durationMs = Math.max(0, input.endedAt - input.startedAt);
	const metrics: ToolCallMetrics = {
		level,
		timeUnit: "ms",
		startedAt: input.startedAt,
		endedAt: input.endedAt,
		durationMs,
		status: input.status,
	};
	if (input.useless && input.status === "ok") metrics.uselessReason = "tool-declared";

	if (atLeast(level, "rich")) {
		if (input.queuedAt !== undefined) {
			metrics.queuedMs = Math.max(0, input.startedAt - input.queuedAt);
		}
		if (input.concurrency !== undefined) metrics.concurrency = input.concurrency;
		if (input.batchId !== undefined) metrics.batchId = input.batchId;
		if (input.batchIndex !== undefined) metrics.batchIndex = input.batchIndex;
		if (input.batchSize !== undefined) metrics.batchSize = input.batchSize;

		const content = input.resultContent ?? [];
		metrics.resultBlocks = content.length;
		let bytes = 0;
		let images = 0;
		const textParts: string[] = [];
		for (const block of content) {
			if (block.type === "text") {
				bytes += utf8Bytes(block.text);
				textParts.push(block.text);
			} else if (block.type === "image") {
				images += 1;
			}
		}
		metrics.resultBytes = bytes;
		metrics.resultImages = images;
		if (input.countTokens && textParts.length > 0) {
			metrics.resultTokens = input.countTokens(textParts.join("\n"));
		} else if (input.countTokens) {
			metrics.resultTokens = 0;
		}
	}

	if (atLeast(level, "ultra")) {
		if (input.args !== undefined) {
			try {
				const serialized = stableSerialize(input.args);
				if (typeof serialized === "string") {
					metrics.argsBytes = utf8Bytes(serialized);
					metrics.argsHash = legacyArgsHash(serialized);
					metrics.argsDigest = stableArgsDigest(serialized);
					metrics.argsDigestAlgorithm = "sha256-128";
				}
			} catch {
				// Hooks may mutate valid model JSON into cyclic or non-JSON values.
				// Instrumentation must never suppress a completed tool result.
			}
		}
		if (input.interruptible !== undefined) metrics.interruptible = input.interruptible;
		if (input.signalAborted !== undefined) metrics.signalAborted = input.signalAborted;
	}

	return metrics;
}

/**
 * Re-project an already captured tool record at the detail permitted by the
 * canonical session policy. Persistence adapters call this fail-closed even
 * when the producer was configured correctly, so an over-detailed or stale
 * in-memory message cannot leak richer fields into JSONL.
 */
export function toolCallMetricsForPersistence(
	metrics: ToolCallMetrics | undefined,
	level: InstrumentationLevel | undefined,
): ToolCallMetrics | undefined {
	if (!metrics) return undefined;
	const permittedDetail = sessionTelemetryDetail(level, "tool-span");
	if (permittedDetail === "none" || metrics.level === "off") return undefined;
	const detail =
		instrumentationRank(metrics.level) < instrumentationRank(permittedDetail) ? metrics.level : permittedDetail;

	const persisted: ToolCallMetrics = {
		level: detail,
		timeUnit: "ms",
		startedAt: metrics.startedAt,
		endedAt: metrics.endedAt,
		durationMs: metrics.durationMs,
		status: metrics.status,
	};
	if (metrics.status === "ok" && metrics.uselessReason === "tool-declared") {
		persisted.uselessReason = "tool-declared";
	}

	if (detail === "rich" || detail === "ultra") {
		if (metrics.queuedMs !== undefined) persisted.queuedMs = metrics.queuedMs;
		if (metrics.concurrency !== undefined) persisted.concurrency = metrics.concurrency;
		if (metrics.batchId !== undefined) persisted.batchId = metrics.batchId;
		if (metrics.batchIndex !== undefined) persisted.batchIndex = metrics.batchIndex;
		if (metrics.batchSize !== undefined) persisted.batchSize = metrics.batchSize;
		if (metrics.resultBytes !== undefined) persisted.resultBytes = metrics.resultBytes;
		if (metrics.resultBlocks !== undefined) persisted.resultBlocks = metrics.resultBlocks;
		if (metrics.resultImages !== undefined) persisted.resultImages = metrics.resultImages;
		if (metrics.resultTokens !== undefined) persisted.resultTokens = metrics.resultTokens;
	}
	if (detail === "ultra") {
		if (metrics.argsBytes !== undefined) persisted.argsBytes = metrics.argsBytes;
		if (metrics.argsHash !== undefined) persisted.argsHash = metrics.argsHash;
		if (metrics.argsDigest !== undefined) persisted.argsDigest = metrics.argsDigest;
		if (metrics.argsDigestAlgorithm !== undefined) persisted.argsDigestAlgorithm = metrics.argsDigestAlgorithm;
		if (metrics.interruptible !== undefined) persisted.interruptible = metrics.interruptible;
		if (metrics.signalAborted !== undefined) persisted.signalAborted = metrics.signalAborted;
	}
	return persisted;
}

/**
 * Raw materials the loop hands to {@link captureAssistantTurnMetrics}. The loop
 * stamps the request-start and finalize wall-clock at its own boundary (the same
 * way it stamps tool `startedAt`/`endedAt`), reads `ttftMs` off the provider's
 * finalized message, and passes the turn `usage` through; the capture function
 * decides which fields survive into the record based on the level.
 */
export interface AssistantTurnMetricsInput {
	level: InstrumentationLevel;
	startedAt: number;
	endedAt: number;
	status: AssistantTurnStatus;
	ttftMs?: number;
	usage?: Usage;
	previousCacheReadTokens?: number;
	upstreamProvider?: string;
}
/**
 * Build the level-gated per-turn metrics record, or `undefined` at `off`. This
 * is the single mapping from level to captured fields for a model turn: the
 * `basic` block (request-start/end wall-clock + ttft) is always filled, `rich`
 * adds token counts and throughput derived from the turn's own usage, `ultra`
 * adds cache/reasoning/provenance detail. Purely arithmetic — no allocation
 * beyond the record itself, so even `ultra` is a rounding error on the turn.
 */
export function captureAssistantTurnMetrics(input: AssistantTurnMetricsInput): AssistantTurnMetrics | undefined {
	const { level } = input;
	if (level === "off") return undefined;

	const durationMs = Math.max(0, input.endedAt - input.startedAt);
	const metrics: AssistantTurnMetrics = {
		level,
		startedAt: input.startedAt,
		endedAt: input.endedAt,
		durationMs,
		status: input.status,
	};
	const ttftMs =
		input.ttftMs !== undefined && Number.isFinite(input.ttftMs) && input.ttftMs >= 0 && input.ttftMs <= durationMs
			? input.ttftMs
			: undefined;
	if (ttftMs !== undefined) metrics.ttftMs = ttftMs;

	if (atLeast(level, "rich")) {
		const usage = input.usage;
		if (usage) {
			metrics.outputTokens = usage.output;
			metrics.inputTokens = usage.input;
			metrics.totalTokens = usage.totalTokens;
		}
		const generationMs = ttftMs !== undefined ? Math.max(0, durationMs - ttftMs) : durationMs;
		metrics.generationMs = generationMs;
		if (usage && usage.output > 0 && generationMs > 0) {
			metrics.outputTokensPerSec = usage.output / (generationMs / 1000);
		}
	}

	if (atLeast(level, "ultra")) {
		const usage = input.usage;
		if (usage) {
			metrics.cacheReadTokens = usage.cacheRead;
			metrics.cacheWriteTokens = usage.cacheWrite;
			if (usage.reasoningTokens !== undefined) metrics.reasoningTokens = usage.reasoningTokens;
			const totalInput = (usage.cacheRead ?? 0) + (usage.input ?? 0);
			if (totalInput > 0) {
				metrics.cacheHitRatio = (usage.cacheRead ?? 0) / totalInput;
			}
			if (
				input.previousCacheReadTokens !== undefined &&
				input.previousCacheReadTokens > 1000 &&
				(usage.cacheRead ?? 0) < input.previousCacheReadTokens * 0.5
			) {
				metrics.isCacheBust = true;
				metrics.cacheBustDeltaTokens = input.previousCacheReadTokens - (usage.cacheRead ?? 0);
			}
		}
		if (input.upstreamProvider !== undefined) metrics.upstreamProvider = input.upstreamProvider;
	}

	return metrics;
}

/**
 * Re-project already captured assistant-turn metrics at the current persistence
 * level. This is the fail-closed boundary for live instrumentation downgrades.
 */
export function assistantTurnMetricsForPersistence(
	metrics: AssistantTurnMetrics | undefined,
	level: InstrumentationLevel | undefined,
): AssistantTurnMetrics | undefined {
	if (!metrics || metrics.level === "off") return undefined;
	const permittedDetail = sessionTelemetryDetail(level, "model-turn");
	if (permittedDetail === "none") return undefined;
	const persistedLevel =
		instrumentationRank(metrics.level) < instrumentationRank(permittedDetail) ? metrics.level : permittedDetail;
	const persisted: AssistantTurnMetrics = {
		level: persistedLevel,
		startedAt: metrics.startedAt,
		endedAt: metrics.endedAt,
		durationMs: metrics.durationMs,
		status: metrics.status,
	};
	if (metrics.ttftMs !== undefined) persisted.ttftMs = metrics.ttftMs;
	if (atLeast(persistedLevel, "rich")) {
		if (metrics.outputTokens !== undefined) persisted.outputTokens = metrics.outputTokens;
		if (metrics.inputTokens !== undefined) persisted.inputTokens = metrics.inputTokens;
		if (metrics.totalTokens !== undefined) persisted.totalTokens = metrics.totalTokens;
		if (metrics.generationMs !== undefined) persisted.generationMs = metrics.generationMs;
		if (metrics.outputTokensPerSec !== undefined) persisted.outputTokensPerSec = metrics.outputTokensPerSec;
	}
	if (atLeast(persistedLevel, "ultra")) {
		if (metrics.cacheReadTokens !== undefined) persisted.cacheReadTokens = metrics.cacheReadTokens;
		if (metrics.cacheWriteTokens !== undefined) persisted.cacheWriteTokens = metrics.cacheWriteTokens;
		if (metrics.reasoningTokens !== undefined) persisted.reasoningTokens = metrics.reasoningTokens;
		if (metrics.cacheHitRatio !== undefined) persisted.cacheHitRatio = metrics.cacheHitRatio;
		if (metrics.isCacheBust !== undefined) persisted.isCacheBust = metrics.isCacheBust;
		if (metrics.cacheBustDeltaTokens !== undefined) {
			persisted.cacheBustDeltaTokens = metrics.cacheBustDeltaTokens;
		}
		if (metrics.upstreamProvider !== undefined) persisted.upstreamProvider = metrics.upstreamProvider;
	}
	return persisted;
}

/** Raw per-turn request values the loop hands to {@link captureAssistantTurnRequest}. */
export interface AssistantTurnRequestInput extends AssistantTurnRequest {
	level: InstrumentationLevel;
}

/**
 * Build the per-turn request record, or `undefined` at `off` (or when nothing was
 * overridden, so an all-defaults turn adds no empty object). Unlike the metrics
 * capture there is no per-tier field selection: request params are cheap scalars
 * captured whole at any on level. This keeps the "what to record for a turn"
 * decision in one place alongside {@link captureAssistantTurnMetrics}.
 */
export function captureAssistantTurnRequest(input: AssistantTurnRequestInput): AssistantTurnRequest | undefined {
	if (input.level === "off") return undefined;
	const request: AssistantTurnRequest = {};
	if (input.temperature !== undefined) request.temperature = input.temperature;
	if (input.topP !== undefined) request.topP = input.topP;
	if (input.topK !== undefined) request.topK = input.topK;
	if (input.maxTokens !== undefined) request.maxTokens = input.maxTokens;
	if (input.presencePenalty !== undefined) request.presencePenalty = input.presencePenalty;
	if (input.reasoningEffort !== undefined) request.reasoningEffort = input.reasoningEffort;
	if (input.disableReasoning !== undefined) request.disableReasoning = input.disableReasoning;
	if (input.toolChoice !== undefined) request.toolChoice = input.toolChoice;
	if (input.serviceTier !== undefined) request.serviceTier = input.serviceTier;
	return Object.keys(request).length > 0 ? request : undefined;
}

/** Fail-closed persistence gate for a request captured before a live setting downgrade. */
export function assistantTurnRequestForPersistence(
	request: AssistantTurnRequest | undefined,
	level: InstrumentationLevel | undefined,
): AssistantTurnRequest | undefined {
	return allowsSessionTelemetry(level, "model-request") ? request : undefined;
}

/**
 * Deterministic JSON serialization with sorted object keys, so two calls with
 * the same arguments in a different key order fingerprint identically.
 */
function stableSerialize(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === "object") {
		const source = value as Record<string, unknown>;
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort()) {
			sorted[key] = sortKeys(source[key]);
		}
		return sorted;
	}
	return value;
}
