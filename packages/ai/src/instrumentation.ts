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

type MetricsTier = "rich" | "ultra";

/** The optional fields of one record type, split by the tier that captures and persists them. */
interface TierFields<K> {
	rich: readonly K[];
	ultra: readonly K[];
}

/**
 * Tier of every tool-call field beyond `basic`. The `Record` type covers every non-basic key of
 * {@link ToolCallMetrics}, so a new field fails to compile until it is assigned a tier here.
 * Insertion order is the persisted key order.
 */
const TOOL_CALL_FIELD_TIERS: Record<
	Exclude<
		keyof ToolCallMetrics,
		"level" | "timeUnit" | "startedAt" | "endedAt" | "durationMs" | "status" | "uselessReason"
	>,
	MetricsTier
> = {
	queuedMs: "rich",
	concurrency: "rich",
	batchId: "rich",
	batchIndex: "rich",
	batchSize: "rich",
	resultBytes: "rich",
	resultBlocks: "rich",
	resultImages: "rich",
	resultTokens: "rich",
	argsBytes: "ultra",
	argsHash: "ultra",
	argsDigest: "ultra",
	argsDigestAlgorithm: "ultra",
	interruptible: "ultra",
	signalAborted: "ultra",
};

/** Tier of every assistant-turn field beyond `basic`; see {@link TOOL_CALL_FIELD_TIERS}. */
const ASSISTANT_TURN_FIELD_TIERS: Record<
	Exclude<keyof AssistantTurnMetrics, "level" | "startedAt" | "endedAt" | "durationMs" | "status" | "ttftMs">,
	MetricsTier
> = {
	outputTokens: "rich",
	inputTokens: "rich",
	totalTokens: "rich",
	generationMs: "rich",
	outputTokensPerSec: "rich",
	cacheReadTokens: "ultra",
	cacheWriteTokens: "ultra",
	reasoningTokens: "ultra",
	cacheHitRatio: "ultra",
	isCacheBust: "ultra",
	cacheBustDeltaTokens: "ultra",
	upstreamProvider: "ultra",
};

function tierFields<K extends string>(tiers: Record<K, MetricsTier>): TierFields<K> {
	const keys = Object.keys(tiers) as K[];
	return { rich: keys.filter(key => tiers[key] === "rich"), ultra: keys.filter(key => tiers[key] === "ultra") };
}

const TOOL_CALL_TIER_FIELDS = tierFields(TOOL_CALL_FIELD_TIERS);
const ASSISTANT_TURN_TIER_FIELDS = tierFields(ASSISTANT_TURN_FIELD_TIERS);

/** Copies each defined field of `source` that `level` permits onto `target`, in tier order. */
function copyTierFields<T extends object, K extends keyof T>(
	target: T,
	source: T,
	level: InstrumentationLevel,
	fields: TierFields<K>,
): void {
	if (atLeast(level, "rich")) copyDefinedFields(target, source, fields.rich);
	if (atLeast(level, "ultra")) copyDefinedFields(target, source, fields.ultra);
}

function copyDefinedFields<T extends object, K extends keyof T>(target: T, source: T, keys: readonly K[]): void {
	for (const key of keys) {
		const value = source[key];
		if (value !== undefined) target[key] = value;
	}
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

	const metrics: ToolCallMetrics = {
		level,
		timeUnit: "ms",
		startedAt: input.startedAt,
		endedAt: input.endedAt,
		durationMs: Math.max(0, input.endedAt - input.startedAt),
		status: input.status,
	};
	if (input.useless && input.status === "ok") metrics.uselessReason = "tool-declared";

	if (atLeast(level, "rich")) {
		captureToolSchedule(metrics, input);
		captureToolResultWeight(metrics, input.resultContent ?? [], input.countTokens);
	}
	if (atLeast(level, "ultra")) {
		if (input.args !== undefined) captureArgsFingerprint(metrics, input.args);
		if (input.interruptible !== undefined) metrics.interruptible = input.interruptible;
		if (input.signalAborted !== undefined) metrics.signalAborted = input.signalAborted;
	}
	return metrics;
}

function captureToolSchedule(metrics: ToolCallMetrics, input: ToolCallMetricsInput): void {
	if (input.queuedAt !== undefined) metrics.queuedMs = Math.max(0, input.startedAt - input.queuedAt);
	if (input.concurrency !== undefined) metrics.concurrency = input.concurrency;
	if (input.batchId !== undefined) metrics.batchId = input.batchId;
	if (input.batchIndex !== undefined) metrics.batchIndex = input.batchIndex;
	if (input.batchSize !== undefined) metrics.batchSize = input.batchSize;
}

/** Block, byte, image and token weight of a tool result. Bytes are counted without encoding the text. */
function captureToolResultWeight(
	metrics: ToolCallMetrics,
	content: readonly (TextContent | ImageContent)[],
	countTokens: ((text: string) => number) | undefined,
): void {
	metrics.resultBlocks = content.length;
	let bytes = 0;
	let images = 0;
	const textParts: string[] | undefined = countTokens ? [] : undefined;
	for (const block of content) {
		if (block.type === "text") {
			bytes += Buffer.byteLength(block.text, "utf8");
			textParts?.push(block.text);
		} else if (block.type === "image") {
			images += 1;
		}
	}
	metrics.resultBytes = bytes;
	metrics.resultImages = images;
	if (countTokens && textParts) {
		metrics.resultTokens = textParts.length > 0 ? countTokens(textParts.join("\n")) : 0;
	}
}

function captureArgsFingerprint(metrics: ToolCallMetrics, args: Record<string, unknown>): void {
	try {
		const serialized = stableSerialize(args);
		if (typeof serialized !== "string") return;
		metrics.argsBytes = Buffer.byteLength(serialized, "utf8");
		metrics.argsHash = legacyArgsHash(serialized);
		metrics.argsDigest = stableArgsDigest(serialized);
		metrics.argsDigestAlgorithm = "sha256-128";
	} catch {
		// Hooks may mutate valid model JSON into cyclic or non-JSON values.
		// Instrumentation must never suppress a completed tool result.
	}
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
	copyTierFields(persisted, metrics, detail, TOOL_CALL_TIER_FIELDS);
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

	if (atLeast(level, "rich")) captureTurnThroughput(metrics, input.usage, durationMs, ttftMs);
	if (atLeast(level, "ultra")) {
		if (input.usage) captureTurnCache(metrics, input.usage, input.previousCacheReadTokens);
		if (input.upstreamProvider !== undefined) metrics.upstreamProvider = input.upstreamProvider;
	}
	return metrics;
}

function captureTurnThroughput(
	metrics: AssistantTurnMetrics,
	usage: Usage | undefined,
	durationMs: number,
	ttftMs: number | undefined,
): void {
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

/** Cache efficiency of a turn; a bust is a drop below half of a previous read above 1000 tokens. */
function captureTurnCache(
	metrics: AssistantTurnMetrics,
	usage: Usage,
	previousCacheReadTokens: number | undefined,
): void {
	metrics.cacheReadTokens = usage.cacheRead;
	metrics.cacheWriteTokens = usage.cacheWrite;
	if (usage.reasoningTokens !== undefined) metrics.reasoningTokens = usage.reasoningTokens;
	const cacheRead = usage.cacheRead ?? 0;
	const totalInput = cacheRead + (usage.input ?? 0);
	if (totalInput > 0) metrics.cacheHitRatio = cacheRead / totalInput;
	if (
		previousCacheReadTokens !== undefined &&
		previousCacheReadTokens > 1000 &&
		cacheRead < previousCacheReadTokens * 0.5
	) {
		metrics.isCacheBust = true;
		metrics.cacheBustDeltaTokens = previousCacheReadTokens - cacheRead;
	}
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
	copyTierFields(persisted, metrics, persistedLevel, ASSISTANT_TURN_TIER_FIELDS);
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
