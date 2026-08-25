/**
 * Unified type contracts for cross-system benchmarking and adapter registration.
 */
import type { ArmResult } from "../aggregate/types";

export interface ComparisonArtifacts {
	patch: string;
	transcript: string;
	log: string;
}

/** Provenance for a real continuation replay frozen immediately before compaction. */
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

/** Inputs which must be identical within one paired (task, repeat) cell. */
export interface ComparisonExecution {
	taskInstructionsHash: string;
	repositoryStateHash: string;
	wallClockLimitSeconds: number;
	temperature: number | null;
	samplingDescription: string;
}

/**
 * The portable result contract shared by all Pier adapters.
 *
 * `qualitativeScore` is an outcome produced by the real replay evaluator. This
 * module deliberately does not invent fixtures, replay sessions, or a scoring
 * formula; it only validates and aggregates outcomes supplied by that evaluator.
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

export interface ComparisonArmResult extends ArmResult {
	system?: string | null;
	requestedModel?: string | null;
	resolvedModel?: string | null;
	providerCostSupported?: boolean | null;
	qualitativeScore?: number | null;
	recoveryReads?: number | null;
	recoveryTokens?: number | null;
	artifacts?: Partial<ComparisonArtifacts> | null;
	execution?: Partial<ComparisonExecution> | null;
	replay?: ReplayCorpusTrial | null;
	nativeCompaction?: NativeCompactionEvidence | null;
}

export interface SystemStageContext {
	system: string;
	assetsDir: string;
	outRoot: string;
	binarySha?: string | null;
	args: Record<string, string>;
	model: string;
}

export interface SystemJobConfigContext {
	system: string;
	task: string;
	repeat: number;
	model: string;
	assetsDir: string;
	binarySha?: string | null;
	replayPath?: string | null;
	promptTemplatePath?: string | null;
	armName?: string | null;
	comparisonMode: boolean;
}

export interface SystemPreflightContext {
	system: string;
	model: string;
	args: Record<string, string>;
	dryRun: boolean;
}

export interface SystemPreflightResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
}

/**
 * Contract for a pluggable agent system in DeepSWE benchmarks.
 */
export interface SystemAdapter {
	readonly name: string;
	readonly displayName: string;
	readonly pierAgentImport: string;
	readonly description: string;
	readonly supportsReplay: boolean;
	readonly supportsCompaction: boolean;
	readonly supportsArmAttachments: boolean;
	readonly defaultModel: string | null;
	readonly containerAssetsDir: string;

	validatePreflight(context: SystemPreflightContext): Promise<SystemPreflightResult> | SystemPreflightResult;
	stageAssets(context: SystemStageContext): Promise<void> | void;
	buildJobConfigKwargs(context: SystemJobConfigContext): Record<string, unknown>;
}
