/**
 * Core result types for DeepSWE evaluations.
 */

import type { EncodeHeadroom } from "./encode-probe";

export interface ArmResult {
	arm: string;
	task: string;
	repeat: number;
	reward: number | null;
	partial: number | null;
	f2p?: number | null;
	p2p?: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	costUsd: number | null;
	cacheTokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	promptCacheInvalidations?: readonly string[] | null;
	agentSeconds: number | null;
	argotLoadCalls?: number | null;
	assistantMsgsWithSigil?: number | null;
	argotPreamblePresent?: boolean | null;
	argotHandlesLoaded?: number | null;
	argotHandlesTaught?: boolean | null;
	encodeHeadroom?: EncodeHeadroom | null;
	toolCalls?: Record<string, number> | null;
	error: string | null;
}

export interface SessionUsage {
	inputTokens: number;
	outputTokens: number;
	cacheTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	argotLoadCalls: number;
	assistantMsgsWithSigil: number;
	toolCalls: Record<string, number>;
}

export interface CellSummary {
	total: number;
	errors: number;
	timedOut: number;
	n: number;
	passes: number;
	passRate: number | null;
	stdErr: number | null;
	wilsonLow: number | null;
	wilsonHigh: number | null;
	meanReward: number | null;
	meanPartial: number | null;
	meanOutputTokens: number | null;
	meanInputTokens: number | null;
	meanCostUsd: number | null;
	sumOutputTokens: number;
	sumCostUsd: number;
	sumInputTokens: number;
	sumCacheTokens: number;
	sumAgentSeconds: number;
	costPriced: boolean;
	refCost: {
		input: number;
		cacheRead: number;
		cacheWrite: number;
		output: number;
		total: number;
	};
	refCostMeasurable: boolean;
}
