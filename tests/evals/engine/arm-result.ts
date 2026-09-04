/**
 * Result shapes for arm trials and cross-system comparison.
 */

export interface EncodeHeadroom {
	readonly emittedChars: number;
	readonly handles: number;
	readonly usableHandles: number;
	readonly maxSavedChars: number;
	readonly maxSavedPct: number;
}

export interface ComparisonArtifacts {
	readonly patch: string | null;
	readonly transcript: string | null;
	readonly log: string | null;
}

export interface ReplayCorpusTrial {
	readonly manifestSha256: string;
	readonly sourceSessionId: string;
	readonly sourceSessionArtifacts: readonly string[];
	readonly repositoryCheckpoint: string;
	readonly compactionBoundary: string;
	readonly sourceThresholdTokens: number;
	readonly sourceContextTokens: number;
	readonly continuationId: string;
	readonly continuationArtifact: string;
}

export interface NativeCompactionEvidence {
	readonly native: boolean;
	readonly artifact: string;
	readonly beforeTokens: number | null;
	readonly afterTokens: number | null;
}

export interface ComparisonExecution {
	readonly taskInstructionsHash: string;
	readonly repositoryStateHash: string;
	readonly wallClockLimitSeconds: number;
	readonly temperature: number | null;
	readonly samplingDescription: string;
}

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
	exceptionInfo?: Record<string, unknown> | null;
}

export interface ComparisonArmResult extends ArmResult {
	system?: string | null;
	requestedModel?: string | null;
	resolvedModel?: string | null;
	providerCostSupported?: boolean | null;
	qualitativeScore?: number | null;
	recoveryReads?: number | null;
	recoveryTokens?: number | null;
	artifacts?: ComparisonArtifacts | null;
	nativeCompaction?: NativeCompactionEvidence | null;
	replay?: ReplayCorpusTrial | null;
	execution?: ComparisonExecution | null;
}
