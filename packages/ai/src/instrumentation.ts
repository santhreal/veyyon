import type { Usage } from "@veyyon/catalog/types";
import type { ImageContent, ServiceTier, TextContent, ToolChoice } from "./types";

export const INSTRUMENTATION_LEVELS = ["off", "basic", "rich", "ultra"] as const;

export type InstrumentationLevel = (typeof INSTRUMENTATION_LEVELS)[number];

export function instrumentationRank(level: InstrumentationLevel | undefined): number {
	const index = level === undefined ? 0 : INSTRUMENTATION_LEVELS.indexOf(level);
	return index < 0 ? 0 : index;
}

export function atLeast(level: InstrumentationLevel | undefined, minimum: InstrumentationLevel): boolean {
	return instrumentationRank(level) >= instrumentationRank(minimum);
}

export type SessionTelemetryCategory =
	| "lifecycle"
	| "context-breakdown"
	| "tool-span"
	| "model-turn"
	| "model-request"
	| "agent-communication"
	| "goal-verification";

export type SessionTelemetryDetail = "none" | Exclude<InstrumentationLevel, "off">;

export const SESSION_TELEMETRY_POLICY = {
	lifecycle: "basic",
	"context-breakdown": "rich",
	"tool-span": "basic",
	"model-turn": "basic",
	"model-request": "basic",
	"agent-communication": "rich",
	"goal-verification": "basic",
} as const satisfies Record<SessionTelemetryCategory, Exclude<InstrumentationLevel, "off">>;

export function sessionTelemetryDetail(
	level: InstrumentationLevel | undefined,
	category: SessionTelemetryCategory,
): SessionTelemetryDetail {
	const rank = instrumentationRank(level);
	if (rank < instrumentationRank(SESSION_TELEMETRY_POLICY[category])) return "none";
	if (level === "basic" || level === "rich" || level === "ultra") return level;
	return "none";
}

export function allowsSessionTelemetry(
	level: InstrumentationLevel | undefined,
	category: SessionTelemetryCategory,
): boolean {
	return sessionTelemetryDetail(level, category) !== "none";
}

export type ToolCallStatus = "ok" | "error" | "aborted" | "blocked" | "skipped";

export interface ToolCallMetrics {
	level: InstrumentationLevel;
	timeUnit?: "ms";

	startedAt: number;
	endedAt: number;
	durationMs: number;
	status: ToolCallStatus;
	uselessReason?: "tool-declared";

	queuedMs?: number;
	concurrency?: "shared" | "exclusive";
	batchId?: string;
	batchIndex?: number;
	batchSize?: number;
	resultBytes?: number;
	resultBlocks?: number;
	resultImages?: number;
	resultTokens?: number;

	argsBytes?: number;
	argsHash?: string;
	argsDigest?: string;
	argsDigestAlgorithm?: "sha256-128";
	interruptible?: boolean;
	signalAborted?: boolean;
}

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
	useless?: boolean;
	resultContent?: readonly (TextContent | ImageContent)[];
	args?: Record<string, unknown>;
	countTokens?: (text: string) => number;
}

const textEncoder = new TextEncoder();

function utf8Bytes(text: string): number {
	return textEncoder.encode(text).length;
}

function stableArgsDigest(text: string): string {
	return new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 32);
}

function legacyArgsHash(text: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

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
			} catch {}
		}
		if (input.interruptible !== undefined) metrics.interruptible = input.interruptible;
		if (input.signalAborted !== undefined) metrics.signalAborted = input.signalAborted;
	}

	return metrics;
}

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

export type AssistantTurnStatus = "ok" | "error" | "aborted";

export interface AssistantTurnMetrics {
	level: InstrumentationLevel;

	startedAt: number;
	endedAt: number;
	durationMs: number;
	status: AssistantTurnStatus;
	ttftMs?: number;

	outputTokens?: number;
	inputTokens?: number;
	totalTokens?: number;
	generationMs?: number;
	outputTokensPerSec?: number;

	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	reasoningTokens?: number;
	cacheHitRatio?: number;
	isCacheBust?: boolean;
	cacheBustDeltaTokens?: number;
	upstreamProvider?: string;
}

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

export interface AssistantTurnRequest {
	temperature?: number;
	topP?: number;
	topK?: number;
	maxTokens?: number;
	presencePenalty?: number;
	reasoningEffort?: string;
	disableReasoning?: boolean;
	toolChoice?: ToolChoice;
	serviceTier?: ServiceTier;
}

export interface AssistantTurnRequestInput extends AssistantTurnRequest {
	level: InstrumentationLevel;
}

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

export function assistantTurnRequestForPersistence(
	request: AssistantTurnRequest | undefined,
	level: InstrumentationLevel | undefined,
): AssistantTurnRequest | undefined {
	return allowsSessionTelemetry(level, "model-request") ? request : undefined;
}

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
