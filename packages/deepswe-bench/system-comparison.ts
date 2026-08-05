import type { ArmResult } from "./aggregate";

export const COMPARISON_SYSTEMS = ["veyyon", "factory", "hermes"] as const;
export type ComparisonSystem = (typeof COMPARISON_SYSTEMS)[number];

export const COMPARISON_MODEL = "google-antigravity/gemini-3.6-flash";
export const COMPARISON_TASK_LIST = "tasks/pilot-10.txt";
export const COMPARISON_TASK_LIST_SHA256 = "439b07dfbf30a988286e614b6b200def41b56f2447b249583560a78152cbfa06";

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
 * The portable result contract shared by the three Pier adapters.
 *
 * `qualitativeScore` is an outcome produced by the real replay evaluator. This
 * module deliberately does not invent fixtures, replay sessions, or a scoring
 * formula; it only validates and aggregates outcomes supplied by that evaluator.
 */
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

export class ComparisonRejected extends Error {
	readonly issues: string[];

	constructor(issues: string[]) {
		super(`cross-system comparison rejected:\n${issues.map(issue => `- ${issue}`).join("\n")}`);
		this.name = "ComparisonRejected";
		this.issues = issues;
	}
}

export interface ComparisonArmResult extends ArmResult {
	system?: ComparisonSystem | null;
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

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function sameReplay(a: ReplayCorpusTrial | null, b: ReplayCorpusTrial | null): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function sameExecution(a: ComparisonExecution, b: ComparisonExecution): boolean {
	return (
		a.taskInstructionsHash === b.taskInstructionsHash &&
		a.repositoryStateHash === b.repositoryStateHash &&
		a.wallClockLimitSeconds === b.wallClockLimitSeconds &&
		a.temperature === b.temperature &&
		a.samplingDescription === b.samplingDescription
	);
}

function ratio(numerator: number | null, denominator: number | null, label: string): RatioValue {
	if (numerator === null || denominator === null) {
		return { value: null, supported: false, reason: `${label} is unsupported` };
	}
	if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
		return { value: null, supported: false, reason: `${label} has no positive competitor denominator` };
	}
	return { value: numerator / denominator, supported: true, reason: null };
}

function statusOf(parts: readonly GateStatus[]): GateStatus {
	return parts.includes("fail") ? "fail" : parts.includes("unsupported") ? "unsupported" : "pass";
}

function ratioGate(value: RatioValue, operator: "<" | "<=", threshold: number, label: string): HardGate {
	if (!value.supported || value.value === null) {
		return {
			status: "unsupported",
			operator,
			threshold,
			actualRatio: null,
			reason: value.reason ?? `${label} is unsupported`,
		};
	}
	const passed = operator === "<" ? value.value < threshold : value.value <= threshold;
	return {
		status: passed ? "pass" : "fail",
		operator,
		threshold,
		actualRatio: value.value,
		reason: `${label} ratio ${value.value.toFixed(4)} ${passed ? "meets" : "does not meet"} ${operator} ${threshold}`,
	};
}

function validateTrial(trial: SystemTrialResult, model: string, issues: string[]): void {
	const cell = `${trial.system}/${trial.task}/r${trial.repeat}`;
	if (trial.error) issues.push(`${cell}: infrastructure/agent error: ${trial.error}`);
	if (trial.requestedModel !== model)
		issues.push(`${cell}: requested model ${JSON.stringify(trial.requestedModel)} != ${model}`);
	if (trial.resolvedModel !== model)
		issues.push(`${cell}: resolved model ${JSON.stringify(trial.resolvedModel)} != ${model}`);
	if (!Number.isInteger(trial.repeat) || trial.repeat < 0)
		issues.push(`${cell}: repeat must be a non-negative integer`);
	if (!isFiniteNumber(trial.reward)) issues.push(`${cell}: verifier reward is missing or non-numeric`);
	if (trial.qualitativeScore !== null && !isFiniteNumber(trial.qualitativeScore)) {
		issues.push(`${cell}: qualitative score is non-numeric`);
	}
	for (const [name, value] of [
		["recovery reads", trial.recoveryReads],
		["recovery tokens", trial.recoveryTokens],
	] as const) {
		if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
			issues.push(`${cell}: ${name} are invalid`);
		}
	}
	for (const [name, value] of [
		["input", trial.inputTokens],
		["output", trial.outputTokens],
		["cache", trial.cacheTokens],
	] as const) {
		if (!Number.isSafeInteger(value) || value < 0) issues.push(`${cell}: ${name} tokens are missing or invalid`);
	}
	if (trial.inputTokens + trial.outputTokens + trial.cacheTokens <= 0) {
		issues.push(`${cell}: zero-token result is an infrastructure failure`);
	}
	if (!isFiniteNumber(trial.wallSeconds) || trial.wallSeconds <= 0)
		issues.push(`${cell}: wall time is missing or non-positive`);
	if (typeof trial.providerCostSupported !== "boolean") issues.push(`${cell}: provider cost support state is missing`);
	if (trial.providerCostSupported) {
		if (!isFiniteNumber(trial.costUsd) || trial.costUsd < 0)
			issues.push(`${cell}: supported provider cost is missing or invalid`);
	} else if (trial.costUsd !== null) {
		issues.push(`${cell}: unsupported provider cost must be null, not a fabricated value`);
	}
	for (const [name, artifact] of Object.entries(trial.artifacts)) {
		if (!nonEmpty(artifact)) issues.push(`${cell}: ${name} artifact path is missing`);
	}
	if (!nonEmpty(trial.execution.taskInstructionsHash)) issues.push(`${cell}: task-instruction hash is missing`);
	if (!nonEmpty(trial.execution.repositoryStateHash)) issues.push(`${cell}: repository-state hash is missing`);
	if (!isFiniteNumber(trial.execution.wallClockLimitSeconds) || trial.execution.wallClockLimitSeconds <= 0) {
		issues.push(`${cell}: wall-clock limit is missing or non-positive`);
	}
	if (!nonEmpty(trial.execution.samplingDescription)) issues.push(`${cell}: sampling description is missing`);
	if (trial.replay) {
		if (!nonEmpty(trial.replay.manifestSha256)) issues.push(`${cell}: replay manifest hash is missing`);
		if (!nonEmpty(trial.replay.sourceSessionId)) issues.push(`${cell}: replay source session is missing`);
		if (
			trial.replay.sourceSessionArtifacts.length === 0 ||
			trial.replay.sourceSessionArtifacts.some(artifact => !nonEmpty(artifact))
		) {
			issues.push(`${cell}: replay source-session artifacts are missing`);
		}
		if (!nonEmpty(trial.replay.repositoryCheckpoint)) issues.push(`${cell}: replay repository checkpoint is missing`);
		if (!nonEmpty(trial.replay.compactionBoundary)) issues.push(`${cell}: replay compaction boundary is missing`);
		if (!Number.isSafeInteger(trial.replay.sourceThresholdTokens) || trial.replay.sourceThresholdTokens < 1) {
			issues.push(`${cell}: replay source compaction threshold is missing`);
		}
		if (
			!Number.isSafeInteger(trial.replay.sourceContextTokens) ||
			trial.replay.sourceContextTokens < trial.replay.sourceThresholdTokens
		) {
			issues.push(`${cell}: replay source context did not reach its compaction threshold`);
		}
		if (!nonEmpty(trial.replay.continuationId)) issues.push(`${cell}: replay continuation id is missing`);
		if (!nonEmpty(trial.replay.continuationArtifact)) issues.push(`${cell}: replay continuation artifact is missing`);
		if (!trial.nativeCompaction?.native || !nonEmpty(trial.nativeCompaction.artifact)) {
			issues.push(`${cell}: replay has no native compaction evidence`);
		}
	} else if (trial.nativeCompaction !== null) {
		issues.push(`${cell}: native compaction evidence was supplied without replay provenance`);
	}
}

/**
 * Convert runner results into the strict comparison contract. Missing fields stay
 * visible and are rejected by {@link aggregateSystemComparison}; no zero/default
 * fallback is introduced here.
 */
export function comparisonTrialsFromArmResults(results: readonly ComparisonArmResult[]): SystemTrialResult[] {
	return results.map(result => ({
		system: result.system ?? (result.arm as ComparisonSystem),
		task: result.task,
		repeat: result.repeat,
		requestedModel: result.requestedModel ?? "",
		resolvedModel: result.resolvedModel ?? "",
		reward: result.reward as number,
		qualitativeScore: result.qualitativeScore ?? null,
		recoveryReads: result.recoveryReads ?? null,
		recoveryTokens: result.recoveryTokens ?? null,
		inputTokens: result.inputTokens as number,
		outputTokens: result.outputTokens as number,
		cacheTokens: result.cacheTokens as number,
		wallSeconds: result.agentSeconds as number,
		providerCostSupported: result.providerCostSupported as boolean,
		costUsd: result.costUsd,
		artifacts: {
			patch: result.artifacts?.patch ?? "",
			transcript: result.artifacts?.transcript ?? "",
			log: result.artifacts?.log ?? "",
		},
		execution: {
			taskInstructionsHash: result.execution?.taskInstructionsHash ?? "",
			repositoryStateHash: result.execution?.repositoryStateHash ?? "",
			wallClockLimitSeconds: result.execution?.wallClockLimitSeconds as number,
			temperature: result.execution?.temperature ?? null,
			samplingDescription: result.execution?.samplingDescription ?? "",
		},
		replay: result.replay ?? null,
		nativeCompaction: result.nativeCompaction ?? null,
		error: result.error,
	}));
}

export function aggregateSystemComparison(
	trials: readonly SystemTrialResult[],
	expectedTasks: readonly string[],
	model: string = COMPARISON_MODEL,
): SystemComparison {
	const issues: string[] = [];
	if (model !== COMPARISON_MODEL) issues.push(`comparison model must be exactly ${COMPARISON_MODEL}, got ${model}`);
	if (expectedTasks.length === 0) issues.push("expected task set is empty");
	if (new Set(expectedTasks).size !== expectedTasks.length) issues.push("expected task set contains duplicates");
	const expectedTaskSet = new Set(expectedTasks);
	const cells = new Map<string, Partial<Record<ComparisonSystem, SystemTrialResult>>>();
	for (const trial of trials) {
		if (!COMPARISON_SYSTEMS.includes(trial.system)) {
			issues.push(`unknown comparison system ${JSON.stringify(trial.system)}`);
			continue;
		}
		if (!expectedTaskSet.has(trial.task))
			issues.push(`${trial.system}/${trial.task}: task is outside the fixed comparison set`);
		validateTrial(trial, model, issues);
		const key = `${trial.task}\u0000${trial.repeat}`;
		const cell = cells.get(key) ?? {};
		if (cell[trial.system]) issues.push(`${trial.system}/${trial.task}/r${trial.repeat}: duplicate result`);
		cell[trial.system] = trial;
		cells.set(key, cell);
	}

	const repeats = [
		...new Set(trials.map(trial => trial.repeat).filter(repeat => Number.isInteger(repeat) && repeat >= 0)),
	].sort((a, b) => a - b);
	if (repeats.length === 0) issues.push("comparison contains no repeats");
	for (const task of expectedTasks) {
		for (const repeat of repeats) {
			const cell = cells.get(`${task}\u0000${repeat}`);
			for (const system of COMPARISON_SYSTEMS) {
				if (!cell?.[system]) issues.push(`${system}/${task}/r${repeat}: missing paired result`);
			}
		}
	}
	for (const [key, cell] of cells) {
		const present = COMPARISON_SYSTEMS.map(system => cell[system]).filter(
			(result): result is SystemTrialResult => result !== undefined,
		);
		if (present.length < 2) continue;
		const first = present[0];
		if (!first) continue;
		for (const other of present.slice(1)) {
			if (!sameExecution(first.execution, other.execution))
				issues.push(`${key}: systems did not receive identical execution inputs`);
			if (!sameReplay(first.replay, other.replay))
				issues.push(`${key}: systems did not replay the same frozen checkpoint/continuation`);
		}
	}
	if (issues.length > 0) throw new ComparisonRejected(issues);

	const pairs: PairedSystemCell[] = [];
	for (const task of expectedTasks) {
		for (const repeat of repeats) {
			const cell = cells.get(`${task}\u0000${repeat}`) as Record<ComparisonSystem, SystemTrialResult>;
			pairs.push({ task, repeat, replay: cell.veyyon.replay, results: cell });
		}
	}

	const totals = Object.fromEntries(
		COMPARISON_SYSTEMS.map(system => {
			const rows = pairs.map(pair => pair.results[system]);
			const qualitative = rows.map(row => row.qualitativeScore).filter((value): value is number => value !== null);
			const recoveryMeasured = rows.every(row => row.recoveryReads !== null && row.recoveryTokens !== null);
			const allCostSupported = rows.every(row => row.providerCostSupported);
			const total: SystemTotals = {
				system,
				tasks: new Set(rows.map(row => row.task)).size,
				trials: rows.length,
				meanReward: rows.reduce((sum, row) => sum + row.reward, 0) / rows.length,
				meanQualitativeScore:
					qualitative.length === rows.length
						? qualitative.reduce((sum, value) => sum + value, 0) / rows.length
						: null,
				recoveryReads: recoveryMeasured ? rows.reduce((sum, row) => sum + (row.recoveryReads as number), 0) : null,
				recoveryTokens: recoveryMeasured
					? rows.reduce((sum, row) => sum + (row.recoveryTokens as number), 0)
					: null,
				recoveryMeasured,
				wallSeconds: rows.reduce((sum, row) => sum + row.wallSeconds, 0),
				inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
				outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
				cacheTokens: rows.reduce((sum, row) => sum + row.cacheTokens, 0),
				totalTokens: rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens + row.cacheTokens, 0),
				providerCostSupported: allCostSupported,
				costUsd: allCostSupported ? rows.reduce((sum, row) => sum + (row.costUsd as number), 0) : null,
			};
			return [system, total];
		}),
	) as unknown as Record<ComparisonSystem, SystemTotals>;

	const veyyon = totals.veyyon;
	const competitors: CompetitorGates[] = (["factory", "hermes"] as const).map(competitor => {
		const other = totals[competitor];
		const ratios: SystemRatios = {
			verifierQuality: ratio(veyyon.meanReward, other.meanReward, "verifier quality"),
			qualitativeQuality: ratio(veyyon.meanQualitativeScore, other.meanQualitativeScore, "qualitative quality"),
			recoveryReads: ratio(veyyon.recoveryReads, other.recoveryReads, "recovery reads"),
			recoveryTokens: ratio(veyyon.recoveryTokens, other.recoveryTokens, "recovery tokens"),
			wallTime: ratio(veyyon.wallSeconds, other.wallSeconds, "wall time"),
			inputTokens: ratio(veyyon.inputTokens, other.inputTokens, "input tokens"),
			outputTokens: ratio(veyyon.outputTokens, other.outputTokens, "output tokens"),
			cacheTokens: ratio(veyyon.cacheTokens, other.cacheTokens, "cache tokens"),
			totalTokens: ratio(veyyon.totalTokens, other.totalTokens, "total tokens"),
			price: ratio(veyyon.costUsd, other.costUsd, "provider price"),
		};
		const hasReplay = pairs.some(pair => pair.replay !== null);
		let quality: HardGate;
		if (
			hasReplay &&
			(!ratios.qualitativeQuality.supported ||
				ratios.qualitativeQuality.value === null ||
				!veyyon.recoveryMeasured ||
				!other.recoveryMeasured)
		) {
			quality = {
				status: "unsupported",
				operator: ">",
				threshold: 1,
				actualRatio: null,
				reason: "real replay comparison is missing a complete qualitative or recovery outcome",
			};
		} else {
			const verifierHigher = veyyon.meanReward > other.meanReward;
			const qualitativeHigher =
				!hasReplay || (veyyon.meanQualitativeScore as number) > (other.meanQualitativeScore as number);
			quality = {
				status: verifierHigher && qualitativeHigher ? "pass" : "fail",
				operator: ">",
				threshold: 1,
				actualRatio: ratios.verifierQuality.value,
				reason: hasReplay
					? `Veyyon verifier and qualitative means must both be higher than ${competitor}`
					: `Veyyon verifier mean must be higher than ${competitor}`,
			};
		}
		const wallTime = ratioGate(ratios.wallTime, "<", 1, "wall time");
		const totalTokens = ratioGate(ratios.totalTokens, "<=", 0.5, "total tokens");
		const price = ratioGate(ratios.price, "<", 0.5, "provider price");
		return {
			competitor,
			ratios,
			quality,
			wallTime,
			totalTokens,
			price,
			overall: statusOf([quality.status, wallTime.status, totalTokens.status, price.status]),
		};
	});

	return {
		model,
		tasks: [...expectedTasks],
		pairs,
		totals,
		competitors,
		overall: statusOf(competitors.map(competitor => competitor.overall)),
	};
}

function fmtRatio(value: RatioValue): string {
	return value.supported && value.value !== null ? `${value.value.toFixed(3)}x` : "unsupported";
}

function fmtCost(total: SystemTotals): string {
	return total.providerCostSupported && total.costUsd !== null ? `$${total.costUsd.toFixed(4)}` : "unsupported";
}

/** Render only observed comparison data; an unsupported metric can never print PASS. */
export function renderSystemComparison(comparison: SystemComparison): string {
	const lines = [
		"# Cross-system DeepSWE comparison",
		"",
		`Model (requested and resolved): \`${comparison.model}\``,
		"",
		"| system | tasks | quality (mean reward) | qualitative | recovery reads | recovery tokens | wall time | input | output | cache | total tokens | provider cost |",
		"|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
	];
	for (const system of COMPARISON_SYSTEMS) {
		const total = comparison.totals[system];
		lines.push(
			`| ${system} | ${total.tasks} | ${total.meanReward.toFixed(4)} | ${total.meanQualitativeScore?.toFixed(4) ?? "n/a"} | ${total.recoveryReads ?? "n/a"} | ${total.recoveryTokens ?? "n/a"} | ${total.wallSeconds.toFixed(1)}s | ${total.inputTokens} | ${total.outputTokens} | ${total.cacheTokens} | ${total.totalTokens} | ${fmtCost(total)} |`,
		);
	}
	lines.push("", "## Veyyon ratios and hard gates", "");
	lines.push(
		"| competitor | verifier quality | qualitative quality | recovery reads | recovery tokens | time | input | output | cache | total tokens | price | quality gate | time gate | token gate | price gate | overall |",
	);
	lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|---|---|");
	for (const gate of comparison.competitors) {
		lines.push(
			`| ${gate.competitor} | ${fmtRatio(gate.ratios.verifierQuality)} | ${fmtRatio(gate.ratios.qualitativeQuality)} | ${fmtRatio(gate.ratios.recoveryReads)} | ${fmtRatio(gate.ratios.recoveryTokens)} | ${fmtRatio(gate.ratios.wallTime)} | ${fmtRatio(gate.ratios.inputTokens)} | ${fmtRatio(gate.ratios.outputTokens)} | ${fmtRatio(gate.ratios.cacheTokens)} | ${fmtRatio(gate.ratios.totalTokens)} | ${fmtRatio(gate.ratios.price)} | ${gate.quality.status} | ${gate.wallTime.status} | ${gate.totalTokens.status} | ${gate.price.status} | **${gate.overall}** |`,
		);
	}
	lines.push("", `**Overall: ${comparison.overall}.** Unsupported competitor metrics prevent a passing verdict.`, "");
	lines.push(
		"## Paired task outcomes",
		"",
		"| task | repeat | Veyyon | Factory | Hermes | replay continuation |",
		"|---|---:|---:|---:|---:|---|",
	);
	for (const pair of comparison.pairs) {
		lines.push(
			`| ${pair.task} | ${pair.repeat} | ${pair.results.veyyon.reward.toFixed(4)} | ${pair.results.factory.reward.toFixed(4)} | ${pair.results.hermes.reward.toFixed(4)} | ${pair.replay?.continuationId ?? "n/a"} |`,
		);
	}
	return `${lines.join("\n")}\n`;
}
