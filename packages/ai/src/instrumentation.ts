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
import type { ImageContent, ServiceTier, TextContent, ToolChoice } from "./types";

/**
 * Ordered richness levels. The order is meaningful: a level includes every
 * field of the levels before it, so {@link instrumentationRank} / {@link atLeast}
 * can gate work by "is the level at least X".
 */
export const INSTRUMENTATION_LEVELS = ["off", "basic", "rich", "ultra"] as const;

export type InstrumentationLevel = (typeof INSTRUMENTATION_LEVELS)[number];

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
	| "agent-communication"
	| "goal-verification"
	| "analytics-rollup";

export type SessionTelemetryDetail = "none" | Exclude<InstrumentationLevel, "off">;

/**
 * Canonical minimum level for every persisted telemetry family.
 *
 * | Category | off | basic | rich | ultra |
 * | --- | --- | --- | --- | --- |
 * | lifecycle | none | basic | rich | ultra |
 * | context-breakdown | none | none | rich | ultra |
 * | tool-span | none | basic | rich | ultra |
 * | agent-communication | none | none | rich | ultra |
 * | goal-verification | none | basic | rich | ultra |
 * | analytics-rollup | none | none | rich | ultra |
 *
 * Permission is only the first boundary. Persistors must still store structured,
 * redacted data: raw secrets and unredacted tool arguments are never permitted
 * at any level.
 */
export const SESSION_TELEMETRY_POLICY = {
	lifecycle: "basic",
	"context-breakdown": "rich",
	"tool-span": "basic",
	"agent-communication": "rich",
	"goal-verification": "basic",
	"analytics-rollup": "rich",
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

/** Terminal state of a single tool call, mirrored from the loop's own status. */
export type ToolCallStatus = "ok" | "error" | "aborted" | "blocked" | "skipped";

/**
 * Dense per-tool-call study record, attached to a {@link ToolResultMessage} as
 * `metrics` when instrumentation is on. Every field beyond the `basic` tier is
 * optional, so a message recorded at a lower level (or by an older build) still
 * satisfies the type and loads unchanged.
 *
 * Times are Unix epoch milliseconds; durations are milliseconds.
 */
export interface ToolCallMetrics {
	/** The level this record was captured at (so a reader knows which fields to expect). */
	level: InstrumentationLevel;
	/** Declared unit for all timestamps and durations in this record. */
	timeUnit?: "ms";

	// ── basic: wall-clock, free ────────────────────────────────────────────
	/** When `tool.execute()` began. */
	startedAt: number;
	/** When the result message was emitted (equals the message timestamp). */
	endedAt: number;
	/** Execution wall-clock: `endedAt - startedAt`. */
	durationMs: number;
	/** Terminal state of the call. */
	status: ToolCallStatus;
	/** Why an otherwise successful result was classified as contextually useless. */
	uselessReason?: "tool-declared";

	// ── rich: scheduling + output weight (one tokenizer pass) ───────────────
	/** Time the call waited between batch dispatch and execution start. */
	queuedMs?: number;
	/** How the scheduler ran it. */
	concurrency?: "shared" | "exclusive";
	/** Id of the tool batch this call ran in. */
	batchId?: string;
	/** Zero-based position within the batch. */
	batchIndex?: number;
	/** Total calls in the batch. */
	batchSize?: number;
	/** UTF-8 byte size of the result's textual content. */
	resultBytes?: number;
	/** Number of content blocks in the result. */
	resultBlocks?: number;
	/** Number of image blocks in the result. */
	resultImages?: number;
	/** Tokens the result adds to context (the weight the model actually pays). */
	resultTokens?: number;

	// ── ultra: everything else worth studying ───────────────────────────────
	/** UTF-8 byte size of the serialized arguments. */
	argsBytes?: number;
	/** Stable fingerprint of the arguments, for spotting repeated identical calls. */
	argsHash?: string;
	/** Collision-resistant fingerprint used by current study aggregation. */
	argsDigest?: string;
	/** Digest algorithm/version for compatibility with legacy 32-bit hashes. */
	argsDigestAlgorithm?: "sha256-128";
	/** Whether the tool declared itself interruptible for this run. */
	interruptible?: boolean;
	/** Whether this call's own abort signal fired during the run. */
	signalAborted?: boolean;
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

/** Terminal state of a single model turn, mirrored from the assistant message's stop reason. */
export type AssistantTurnStatus = "ok" | "error" | "aborted";

/**
 * Dense per-model-turn study record, attached to an {@link AssistantMessage} as
 * `turnMetrics` when instrumentation is on. It is the assistant-turn analogue of
 * {@link ToolCallMetrics}: it turns the loose, scattered `duration`/`ttft` scalars
 * into one graded owner and adds the request-start wall-clock and throughput that
 * a latency/streaming study needs.
 *
 * Every field beyond the `basic` tier is optional, so a message recorded at a
 * lower level (or by an older build) still satisfies the type and loads unchanged.
 * Times are Unix epoch milliseconds; durations are milliseconds.
 */
export interface AssistantTurnMetrics {
	/** The level this record was captured at (so a reader knows which fields to expect). */
	level: InstrumentationLevel;

	// ── basic: wall-clock, free ────────────────────────────────────────────
	/** When the request was dispatched to the provider (loop-measured request start). */
	startedAt: number;
	/** When the turn was finalized (equals the assistant message timestamp). */
	endedAt: number;
	/** Turn wall-clock: `endedAt - startedAt`. */
	durationMs: number;
	/** Terminal state of the turn. */
	status: AssistantTurnStatus;
	/**
	 * Time to first token in milliseconds, as reported by the provider. Kept only
	 * when it is a sane fraction of the turn (`0 <= ttftMs <= durationMs`); a bogus
	 * value (provider clock skew, ttft >= duration) is dropped rather than stored.
	 */
	ttftMs?: number;

	// ── rich: throughput (from usage the turn already carries) ──────────────
	/** Total conversation output tokens for the turn. */
	outputTokens?: number;
	/** Non-cached conversation input tokens. */
	inputTokens?: number;
	/** input + output + cache buckets (+ orchestration when reported). */
	totalTokens?: number;
	/** Generation window after the first token: `durationMs - ttftMs` (or `durationMs` when ttft is unknown). */
	generationMs?: number;
	/** Output tokens per second over the generation window — the streaming throughput. */
	outputTokensPerSec?: number;

	// ── ultra: cache efficiency + provenance ────────────────────────────────
	/** Conversation tokens read from the prompt cache. */
	cacheReadTokens?: number;
	/** Conversation tokens written to the prompt cache. */
	cacheWriteTokens?: number;
	/** Reasoning/thinking tokens included in `outputTokens`, when the provider reports them. */
	reasoningTokens?: number;
	/** Ratio of input tokens served from the prompt cache (0.0 - 1.0). */
	cacheHitRatio?: number;
	/** Whether a prompt cache bust occurred on this turn. */
	isCacheBust?: boolean;
	/** Number of prompt cache tokens lost on this turn due to cache bust. */
	cacheBustDeltaTokens?: number;
	/** Upstream model provider that actually served the turn, when distinct from the gateway. */
	upstreamProvider?: string;
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
	if (!metrics || level === undefined || level === "off" || metrics.level === "off") return undefined;
	const persistedLevel = instrumentationRank(metrics.level) < instrumentationRank(level) ? metrics.level : level;
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

/**
 * Exact per-turn request parameters AS SENT, attached to an {@link AssistantMessage}
 * as `request` when instrumentation is on. Where `turnMetrics` records what a turn
 * DID (timing, throughput), this records what it was ASKED for — the sampling knobs
 * and reasoning/tool directives the loop actually dispatched, so a backtest can
 * reproduce the request rather than guess it from current config.
 *
 * These are the effective, per-turn values (e.g. a harmony-retry temperature bump,
 * a dynamically-resolved reasoning effort, or a one-turn forced tool choice), not
 * the static session defaults — which is why they live on the turn and not only in
 * the start-of-run settings snapshot. The numeric thinking budget is not duplicated
 * here: it derives deterministically from `reasoningEffort` plus the `thinkingBudgets.*`
 * values captured in the settings snapshot.
 *
 * Every field is optional; an unset field means the provider default was used.
 */
export interface AssistantTurnRequest {
	/** Sampling temperature as sent (undefined = provider default). */
	temperature?: number;
	/** Nucleus-sampling top_p as sent. */
	topP?: number;
	/** Top-k as sent. */
	topK?: number;
	/** Max output tokens requested. */
	maxTokens?: number;
	/** Presence penalty as sent. */
	presencePenalty?: number;
	/** Reasoning/thinking effort level as sent; the numeric budget derives from this + thinkingBudgets. */
	reasoningEffort?: string;
	/** Reasoning force-disabled for this turn (overrides the effort). */
	disableReasoning?: boolean;
	/** Tool-choice directive as sent (string form or a specific forced tool). */
	toolChoice?: ToolChoice;
	/** Service tier as sent. */
	serviceTier?: ServiceTier;
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
	return level === undefined || level === "off" ? undefined : request;
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
