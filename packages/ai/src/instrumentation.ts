/** Session instrumentation for recording tool call and model turn metrics. */

import type { Usage } from "@veyyon/catalog/types";
import type { ImageContent, ServiceTier, TextContent, ToolChoice } from "./types";

/** Ordered richness levels. */
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

/** Persisted telemetry families governed by InstrumentationLevel. */
export type SessionTelemetryCategory =
	| "lifecycle"
	| "context-breakdown"
	| "tool-span"
	| "model-turn"
	| "model-request"
	| "agent-communication"
	| "goal-verification";

export type SessionTelemetryDetail = "none" | Exclude<InstrumentationLevel, "off">;

/** Canonical minimum level for every persisted telemetry family. */
export const SESSION_TELEMETRY_POLICY = {
	lifecycle: "basic",
	"context-breakdown": "rich",
	"tool-span": "basic",
	"model-turn": "basic",
	"model-request": "basic",
	"agent-communication": "rich",
	"goal-verification": "basic",
} as const satisfies Record<SessionTelemetryCategory, Exclude<InstrumentationLevel, "off">>;

/** Payload detail permitted for a category at level. */
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

/** Per-tool-call study record attached to ToolResultMessage as metrics. */
export interface ToolCallMetrics {
	/** The level this record was captured at (so a reader knows which fields to expect). */
	level: InstrumentationLevel;
	/** Declared unit for all timestamps and durations in this record. */
	timeUnit?: "ms";

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

/** Input parameters for captureToolCallMetrics. */
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
	/** Token counter used at rich+ to weigh the result. */
	countTokens?: (text: string) => number;
}

const textEncoder = new TextEncoder();

function utf8Bytes(text: string): number {
	return textEncoder.encode(text).length;
}

/** Stable 128-bit SHA-256 prefix for argument fingerprinting. */
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

/** Build the level-gated metrics record for one tool call, or undefined at off. */
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

/** Re-project tool record at detail permitted by session policy. */
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

/** Per-model-turn study record attached to AssistantMessage as turnMetrics. */
export interface AssistantTurnMetrics {
	/** The level this record was captured at (so a reader knows which fields to expect). */
	level: InstrumentationLevel;

	/** When the request was dispatched to the provider (loop-measured request start). */
	startedAt: number;
	/** When the turn was finalized (equals the assistant message timestamp). */
	endedAt: number;
	/** Turn wall-clock: `endedAt - startedAt`. */
	durationMs: number;
	/** Terminal state of the turn. */
	status: AssistantTurnStatus;
	/** Time to first token in milliseconds. */
	ttftMs?: number;

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

/** Input parameters for captureAssistantTurnMetrics. */
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
/** Build the level-gated per-turn metrics record, or undefined at off. */
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

/** Re-project assistant-turn metrics at current persistence level. */
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

/** Exact per-turn request parameters as sent, attached to AssistantMessage as request. */
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

/** Build the per-turn request record, or undefined at off. */
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

/** Deterministic JSON serialization with sorted object keys. */
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
