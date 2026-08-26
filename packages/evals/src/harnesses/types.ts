/**
 * Unified type contracts for cross-system benchmarking and adapter registration.
 */
import type { ArmResult } from "../suites/deep-swe/src/aggregate/types";

export interface ComparisonArtifacts {
	patch: string | null;
	transcript: string | null;
	log: string | null;
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
	artifacts?: ComparisonArtifacts | null;
	nativeCompaction?: NativeCompactionEvidence | null;
	replay?: ReplayCorpusTrial | null;
	execution?: ComparisonExecution | null;
}

export interface SystemStageContext {
	readonly system: string;
	readonly assetsDir: string;
	readonly outRoot: string;
	readonly binarySha: string;
	readonly args: Readonly<Record<string, unknown>>;
	readonly model: string;
}

export interface SystemJobConfigContext {
	readonly system: string;
	readonly task: string;
	readonly repeat: number;
	readonly model: string;
	readonly assetsDir: string;
	readonly binarySha?: string | null;
	readonly replayPath?: string | null;
	readonly promptTemplatePath?: string | null;
	readonly armName?: string | null;
	readonly comparisonMode?: boolean;
}

export interface SystemPreflightContext {
	readonly system: string;
	readonly model: string;
	readonly args: Readonly<Record<string, unknown>>;
	readonly dryRun: boolean;
}

export interface SystemPreflightResult {
	readonly valid: boolean;
	readonly errors: readonly string[];
	readonly warnings: readonly string[];
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
