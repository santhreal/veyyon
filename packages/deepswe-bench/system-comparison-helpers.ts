export const COMPARISON_SYSTEMS = ["veyyon", "factory", "hermes"] as const;
export type ComparisonSystem = (typeof COMPARISON_SYSTEMS)[number];

export const DEFAULT_MODEL = "google-antigravity/gemini-3.5-flash";
export const COMPARISON_MODEL = "google-antigravity/gemini-3.6-flash";
export const COMPARISON_TASK_LIST = "tasks/pilot-10.txt";
export const COMPARISON_TASK_LIST_SHA256 = "439b07dfbf30a988286e614b6b200def41b56f2447b249583560a78152cbfa06";

export interface ComparisonArtifacts {
	patch: string;
	transcript: string;
	log: string;
}

export interface ReplayCorpusTrial {
	manifestSha256: string;
	sourceSessionId: string;
	sourceSessionArtifacts: string[];
	repositoryCheckpoint: string;
	compactionBoundary: string;
	sourceThresholdTokens: number;
	sourceContextTokens: number;
	continuationId: string;
	continuationArtifact: string;
}

export interface NativeCompactionEvidence {
	native: boolean;
	artifact: string;
	beforeTokens: number | null;
	afterTokens: number | null;
}

export interface ComparisonExecution {
	taskInstructionsHash: string;
	repositoryStateHash: string;
	wallClockLimitSeconds: number;
	temperature: number | null;
	samplingDescription: string;
}

export interface SystemTrialResult {
	system: ComparisonSystem;
	task: string;
	repeat: number;
	requestedModel: string;
	resolvedModel: string;
	reward: number;
	qualitativeScore: number | null;
	recoveryReads: number | null;
	recoveryTokens: number | null;
	inputTokens: number;
	outputTokens: number;
	cacheTokens: number;
	wallSeconds: number;
	providerCostSupported: boolean;
	costUsd: number | null;
	artifacts: ComparisonArtifacts;
	execution: ComparisonExecution;
	replay: ReplayCorpusTrial | null;
	nativeCompaction: NativeCompactionEvidence | null;
	error: string | null;
}

export interface SystemTotals {
	system: ComparisonSystem;
	tasks: number;
	trials: number;
	meanReward: number;
	meanQualitativeScore: number | null;
	recoveryReads: number | null;
	recoveryTokens: number | null;
	recoveryMeasured: boolean;
	wallSeconds: number;
	inputTokens: number;
	outputTokens: number;
	cacheTokens: number;
	totalTokens: number;
	providerCostSupported: boolean;
	costUsd: number | null;
}

export interface RatioValue {
	value: number | null;
	supported: boolean;
	reason: string | null;
}

export interface SystemRatios {
	verifierQuality: RatioValue;
	qualitativeQuality: RatioValue;
	recoveryReads: RatioValue;
	recoveryTokens: RatioValue;
	wallTime: RatioValue;
	inputTokens: RatioValue;
	outputTokens: RatioValue;
	cacheTokens: RatioValue;
	totalTokens: RatioValue;
	price: RatioValue;
}

export type GateStatus = "pass" | "fail" | "unsupported";

export interface HardGate {
	status: GateStatus;
	operator: ">" | "<" | "<=";
	threshold: number;
	actualRatio: number | null;
	reason: string;
}

export interface CompetitorGates {
	competitor: Exclude<ComparisonSystem, "veyyon">;
	ratios: SystemRatios;
	quality: HardGate;
	wallTime: HardGate;
	totalTokens: HardGate;
	price: HardGate;
	overall: GateStatus;
}

export interface PairedSystemCell {
	task: string;
	repeat: number;
	replay: ReplayCorpusTrial | null;
	results: Record<ComparisonSystem, SystemTrialResult>;
}

export interface SystemComparison {
	model: string;
	tasks: string[];
	pairs: PairedSystemCell[];
	totals: Record<ComparisonSystem, SystemTotals>;
	competitors: CompetitorGates[];
	overall: GateStatus;
}
