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

	// ── basic: wall-clock, free ────────────────────────────────────────────
	/** When `tool.execute()` began. */
	startedAt: number;
	/** When the result message was emitted (equals the message timestamp). */
	endedAt: number;
	/** Execution wall-clock: `endedAt - startedAt`. */
	durationMs: number;
	/** Terminal state of the call. */
	status: ToolCallStatus;

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
 * FNV-1a over a string, as an 8-hex-digit fingerprint. Small, dependency-free,
 * and deterministic — enough to detect "the model made this exact call again",
 * not a cryptographic hash.
 */
function fnv1a(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
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
		startedAt: input.startedAt,
		endedAt: input.endedAt,
		durationMs,
		status: input.status,
	};

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
			const serialized = stableSerialize(input.args);
			metrics.argsBytes = utf8Bytes(serialized);
			metrics.argsHash = fnv1a(serialized);
		}
		if (input.interruptible !== undefined) metrics.interruptible = input.interruptible;
		if (input.signalAborted !== undefined) metrics.signalAborted = input.signalAborted;
	}

	return metrics;
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
		}
		if (input.upstreamProvider !== undefined) metrics.upstreamProvider = input.upstreamProvider;
	}

	return metrics;
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
