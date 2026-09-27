/**
 * The cross-system comparison contracts: one trial's portable result, per-system totals, the ratios
 * and gates a comparison decides, and the refusal it raises. Adapter registration contracts are in
 * `core/types.ts`.
 */
import type { ComparisonArtifacts, ComparisonExecution, NativeCompactionEvidence, ReplayCorpusTrial } from "./arm-result";

/**
 * The portable result contract shared by all Pier adapters.
 */
export interface SystemTrialResult {
	system: string;
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
	system: string;
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
	competitor: string;
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
	results: Record<string, SystemTrialResult>;
}

export interface SystemComparison {
	model: string;
	referenceSystem: string;
	systems: string[];
	tasks: string[];
	pairs: PairedSystemCell[];
	totals: Record<string, SystemTotals>;
	competitors: CompetitorGates[];
	overall: GateStatus;
}

export class ComparisonRejected extends Error {
	readonly issues: string[];

	constructor(issues: string[]) {
		super(`cross-system comparison rejected:\n${issues.map(issue => `- ${issue}`).join("\n")}`);
		this.name = "ComparisonRejected";
		this.issues = issues;
	}
}
