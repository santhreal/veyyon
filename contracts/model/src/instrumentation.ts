import type { ToolChoice } from "./message";
import type { ServiceTier } from "./service-tier";

/**
 * Ordered richness levels. The order is meaningful: a level includes every
 * field of the levels before it, so {@link instrumentationRank} / {@link atLeast}
 * can gate work by "is the level at least X".
 */
export const INSTRUMENTATION_LEVELS = ["off", "basic", "rich", "ultra"] as const;

export type InstrumentationLevel = (typeof INSTRUMENTATION_LEVELS)[number];

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
