import type { Span } from "@opentelemetry/api";
import type { StopReason } from "@veyyon/ai";

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

export interface ChatStart {
	readonly stepNumber: number;
	readonly startedAtMs: number;
	readonly model: string;
	readonly provider: string;
}

export interface ToolStart {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly startedAtMs: number;
}

export const kChatStart = Symbol("agent.run-collector.chatStart");
export const kToolStart = Symbol("agent.run-collector.toolStart");
export type SpanWithChatStart = Span & { [kChatStart]?: ChatStart };
export type SpanWithToolStart = Span & { [kToolStart]?: ToolStart };
