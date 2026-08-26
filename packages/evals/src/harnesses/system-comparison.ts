/**
 * Generalized cross-system benchmark aggregation and paired gate evaluation.
 */
import { errorMessage } from "@veyyon/utils";
import { requireHarness } from "../core/harness-registry";
import {
	type ComparisonArmResult,
	type ComparisonExecution,
	ComparisonRejected,
	type CompetitorGates,
	type GateStatus,
	type HardGate,
	type PairedSystemCell,
	type RatioValue,
	type SystemComparison,
	type SystemRatios,
	type SystemTotals,
	type SystemTrialResult,
} from "./types";

export { ComparisonRejected } from "./types";

export type ComparisonSystem = string;

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

function sameExecution(a: ComparisonExecution, b: ComparisonExecution): boolean {
	return (
		a.taskInstructionsHash === b.taskInstructionsHash &&
		a.repositoryStateHash === b.repositoryStateHash &&
		a.wallClockLimitSeconds === b.wallClockLimitSeconds &&
		a.temperature === b.temperature &&
		a.samplingDescription === b.samplingDescription
	);
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
	if (typeof trial.reward !== "number" || !Number.isFinite(trial.reward))
		issues.push(`${cell}: verifier reward is missing or non-numeric`);
	if (
		trial.qualitativeScore !== null &&
		(typeof trial.qualitativeScore !== "number" || !Number.isFinite(trial.qualitativeScore))
	) {
		issues.push(`${cell}: qualitative score is non-numeric`);
	}
	if (trial.recoveryReads !== null && (!Number.isSafeInteger(trial.recoveryReads) || trial.recoveryReads < 0)) {
		issues.push(`${cell}: recovery reads are invalid`);
	}
	if (trial.recoveryTokens !== null && (!Number.isSafeInteger(trial.recoveryTokens) || trial.recoveryTokens < 0)) {
		issues.push(`${cell}: recovery tokens are invalid`);
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
	if (typeof trial.wallSeconds !== "number" || !Number.isFinite(trial.wallSeconds) || trial.wallSeconds <= 0)
		issues.push(`${cell}: wall time is missing or non-positive`);
	if (typeof trial.providerCostSupported !== "boolean") issues.push(`${cell}: provider cost support state is missing`);
	if (trial.providerCostSupported) {
		if (typeof trial.costUsd !== "number" || !Number.isFinite(trial.costUsd) || trial.costUsd < 0)
			issues.push(`${cell}: supported provider cost is missing or invalid`);
	} else if (trial.costUsd !== null) {
		issues.push(`${cell}: unsupported provider cost must be null, not a fabricated value`);
	}
	for (const [name, artifact] of Object.entries(trial.artifacts)) {
		if (typeof artifact !== "string" || artifact.trim().length === 0)
			issues.push(`${cell}: ${name} artifact path is missing`);
	}
	if (
		typeof trial.execution.taskInstructionsHash !== "string" ||
		trial.execution.taskInstructionsHash.trim().length === 0
	)
		issues.push(`${cell}: task-instruction hash is missing`);
	if (
		typeof trial.execution.repositoryStateHash !== "string" ||
		trial.execution.repositoryStateHash.trim().length === 0
	)
		issues.push(`${cell}: repository-state hash is missing`);
	if (
		typeof trial.execution.wallClockLimitSeconds !== "number" ||
		!Number.isFinite(trial.execution.wallClockLimitSeconds) ||
		trial.execution.wallClockLimitSeconds <= 0
	) {
		issues.push(`${cell}: wall-clock limit is missing or non-positive`);
	}
	if (
		typeof trial.execution.samplingDescription !== "string" ||
		trial.execution.samplingDescription.trim().length === 0
	)
		issues.push(`${cell}: sampling description is missing`);
	if (trial.replay) {
		if (typeof trial.replay.manifestSha256 !== "string" || trial.replay.manifestSha256.trim().length === 0)
			issues.push(`${cell}: replay manifest hash is missing`);
		if (typeof trial.replay.sourceSessionId !== "string" || trial.replay.sourceSessionId.trim().length === 0)
			issues.push(`${cell}: replay source session is missing`);
		if (
			trial.replay.sourceSessionArtifacts.length === 0 ||
			trial.replay.sourceSessionArtifacts.some(
				artifact => typeof artifact !== "string" || artifact.trim().length === 0,
			)
		) {
			issues.push(`${cell}: replay source-session artifacts are missing`);
		}
		if (
			typeof trial.replay.repositoryCheckpoint !== "string" ||
			trial.replay.repositoryCheckpoint.trim().length === 0
		)
			issues.push(`${cell}: replay repository checkpoint is missing`);
		if (typeof trial.replay.compactionBoundary !== "string" || trial.replay.compactionBoundary.trim().length === 0)
			issues.push(`${cell}: replay compaction boundary is missing`);
		if (!Number.isSafeInteger(trial.replay.sourceThresholdTokens) || trial.replay.sourceThresholdTokens < 1) {
			issues.push(`${cell}: replay source compaction threshold is missing`);
		}
		if (
			!Number.isSafeInteger(trial.replay.sourceContextTokens) ||
			trial.replay.sourceContextTokens < trial.replay.sourceThresholdTokens
		) {
			issues.push(`${cell}: replay source context did not reach its compaction threshold`);
		}
		if (typeof trial.replay.continuationId !== "string" || trial.replay.continuationId.trim().length === 0)
			issues.push(`${cell}: replay continuation id is missing`);
		if (
			typeof trial.replay.continuationArtifact !== "string" ||
			trial.replay.continuationArtifact.trim().length === 0
		)
			issues.push(`${cell}: replay continuation artifact is missing`);
		if (
			!trial.nativeCompaction?.native ||
			typeof trial.nativeCompaction.artifact !== "string" ||
			trial.nativeCompaction.artifact.trim().length === 0
		) {
			issues.push(`${cell}: replay has no native compaction evidence`);
		}
	} else if (trial.nativeCompaction !== null) {
		issues.push(`${cell}: native compaction evidence was supplied without replay provenance`);
	}
}

/**
 * Convert runner results into the strict comparison contract.
 */
export function comparisonTrialsFromArmResults(results: readonly ComparisonArmResult[]): SystemTrialResult[] {
	return results.map(result => ({
		system: result.system ?? result.arm,
		task: result.task,
		repeat: result.repeat,
		requestedModel: result.requestedModel ?? "",
		resolvedModel: result.resolvedModel ?? "",
		reward: (result.reward ?? 0) as number,
		qualitativeScore: result.qualitativeScore ?? null,
		recoveryReads: result.recoveryReads ?? null,
		recoveryTokens: result.recoveryTokens ?? null,
		inputTokens: (result.inputTokens ?? 0) as number,
		outputTokens: (result.outputTokens ?? 0) as number,
		cacheTokens: (result.cacheTokens ?? 0) as number,
		wallSeconds: (result.agentSeconds ?? 0) as number,
		providerCostSupported: Boolean(result.providerCostSupported),
		costUsd: result.costUsd ?? null,
		artifacts: {
			patch: result.artifacts?.patch ?? "",
			transcript: result.artifacts?.transcript ?? "",
			log: result.artifacts?.log ?? "",
		},
		execution: {
			taskInstructionsHash: result.execution?.taskInstructionsHash ?? "",
			repositoryStateHash: result.execution?.repositoryStateHash ?? "",
			wallClockLimitSeconds: (result.execution?.wallClockLimitSeconds ?? 1800) as number,
			temperature: result.execution?.temperature ?? null,
			samplingDescription: result.execution?.samplingDescription ?? "",
		},
		replay: result.replay ?? null,
		nativeCompaction: result.nativeCompaction ?? null,
		error: result.error ?? null,
	}));
}

/**
 * Aggregate results across multiple systems for paired evaluation.
 * Supports arbitrary sets of registered systems (pairwise or multi-way).
 */
export function aggregateSystemComparison(
	trials: readonly SystemTrialResult[],
	expectedTasks: readonly string[],
	requestedModel?: string,
	explicitSystems?: readonly string[],
): SystemComparison {
	const issues: string[] = [];
	// A comparison is only a comparison if every arm ran the same model, and the trials
	// carry which one that was. Naming a model here is therefore optional: pass it to
	// pin what the run asked for, or let the trials say. A hardcoded default was neither
	// — it pinned one vendor's id, so a comparison of any other model validated every
	// arm against a model none of them ran.
	const requestedModels = Array.from(new Set(trials.map(trial => trial.requestedModel).filter(id => id !== "")));
	if (requestedModel === undefined && requestedModels.length > 1) {
		issues.push(`comparison arms requested different models: ${requestedModels.sort().join(", ")}`);
	}
	const model = requestedModel ?? requestedModels[0] ?? "";
	if (!model) issues.push("comparison model is empty");
	if (expectedTasks.length === 0) issues.push("expected task set is empty");
	if (new Set(expectedTasks).size !== expectedTasks.length) issues.push("expected task set contains duplicates");

	const presentSystems = explicitSystems
		? [...explicitSystems]
		: Array.from(new Set(trials.map(t => t.system))).sort();

	if (presentSystems.length < 2) {
		issues.push(`comparison requires at least 2 distinct systems, found: ${presentSystems.join(", ")}`);
	}

	for (const system of presentSystems) {
		try {
			requireHarness(system);
		} catch (err) {
			issues.push(errorMessage(err));
		}
	}

	const expectedTaskSet = new Set(expectedTasks);
	const cells = new Map<string, Record<string, SystemTrialResult>>();

	for (const trial of trials) {
		if (!presentSystems.includes(trial.system)) {
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

	const repeats = Array.from(
		new Set(trials.map(trial => trial.repeat).filter(repeat => Number.isInteger(repeat) && repeat >= 0)),
	).sort((a, b) => a - b);
	if (repeats.length === 0) issues.push("comparison contains no repeats");

	for (const task of expectedTasks) {
		for (const repeat of repeats) {
			const cell = cells.get(`${task}\u0000${repeat}`);
			for (const system of presentSystems) {
				if (!cell?.[system]) issues.push(`${system}/${task}/r${repeat}: missing paired result`);
			}
		}
	}

	for (const [key, cell] of cells) {
		const present = presentSystems
			.map(system => cell[system])
			.filter((result): result is SystemTrialResult => result !== undefined);
		if (present.length < 2) continue;
		const first = present[0];
		if (!first) continue;
		for (const other of present.slice(1)) {
			if (!sameExecution(first.execution, other.execution))
				issues.push(`${key}: systems did not receive identical execution inputs`);
			if (JSON.stringify(first.replay) !== JSON.stringify(other.replay))
				issues.push(`${key}: systems did not replay the same frozen checkpoint/continuation`);
		}
	}

	if (issues.length > 0) throw new ComparisonRejected(issues);

	const referenceSystem = presentSystems.includes("veyyon") ? "veyyon" : presentSystems[0]!;

	const pairs: PairedSystemCell[] = [];
	for (const task of expectedTasks) {
		for (const repeat of repeats) {
			const cell = cells.get(`${task}\u0000${repeat}`) as Record<string, SystemTrialResult>;
			const refReplay = cell[referenceSystem]?.replay ?? null;
			pairs.push({ task, repeat, replay: refReplay, results: cell });
		}
	}

	const totals: Record<string, SystemTotals> = {};
	for (const system of presentSystems) {
		const rows = pairs.map(pair => pair.results[system]!);
		const qualitative = rows.map(row => row.qualitativeScore).filter((value): value is number => value !== null);
		const recoveryMeasured = rows.every(row => row.recoveryReads !== null && row.recoveryTokens !== null);
		const allCostSupported = rows.every(row => row.providerCostSupported);
		totals[system] = {
			system,
			tasks: new Set(rows.map(row => row.task)).size,
			trials: rows.length,
			meanReward: rows.reduce((sum, row) => sum + row.reward, 0) / rows.length,
			meanQualitativeScore:
				qualitative.length === rows.length
					? qualitative.reduce((sum, value) => sum + value, 0) / rows.length
					: null,
			recoveryReads: recoveryMeasured ? rows.reduce((sum, row) => sum + (row.recoveryReads as number), 0) : null,
			recoveryTokens: recoveryMeasured ? rows.reduce((sum, row) => sum + (row.recoveryTokens as number), 0) : null,
			recoveryMeasured,
			wallSeconds: rows.reduce((sum, row) => sum + row.wallSeconds, 0),
			inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
			outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
			cacheTokens: rows.reduce((sum, row) => sum + row.cacheTokens, 0),
			totalTokens: rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens + row.cacheTokens, 0),
			providerCostSupported: allCostSupported,
			costUsd: allCostSupported ? rows.reduce((sum, row) => sum + (row.costUsd as number), 0) : null,
		};
	}

	const reference = totals[referenceSystem]!;
	const competitorSystems = presentSystems.filter(s => s !== referenceSystem);

	const competitors: CompetitorGates[] = competitorSystems.map(competitor => {
		const other = totals[competitor]!;
		const ratios: SystemRatios = {
			verifierQuality: ratio(reference.meanReward, other.meanReward, "verifier quality"),
			qualitativeQuality: ratio(reference.meanQualitativeScore, other.meanQualitativeScore, "qualitative quality"),
			recoveryReads: ratio(reference.recoveryReads, other.recoveryReads, "recovery reads"),
			recoveryTokens: ratio(reference.recoveryTokens, other.recoveryTokens, "recovery tokens"),
			wallTime: ratio(reference.wallSeconds, other.wallSeconds, "wall time"),
			inputTokens: ratio(reference.inputTokens, other.inputTokens, "input tokens"),
			outputTokens: ratio(reference.outputTokens, other.outputTokens, "output tokens"),
			cacheTokens: ratio(reference.cacheTokens, other.cacheTokens, "cache tokens"),
			totalTokens: ratio(reference.totalTokens, other.totalTokens, "total tokens"),
			price: ratio(reference.costUsd, other.costUsd, "provider price"),
		};
		const hasReplay = pairs.some(pair => pair.replay !== null);
		let quality: HardGate;
		if (
			hasReplay &&
			(!ratios.qualitativeQuality.supported ||
				ratios.qualitativeQuality.value === null ||
				!reference.recoveryMeasured ||
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
			const verifierHigher = reference.meanReward > other.meanReward;
			const qualitativeHigher =
				!hasReplay || (reference.meanQualitativeScore as number) > (other.meanQualitativeScore as number);
			quality = {
				status: verifierHigher && qualitativeHigher ? "pass" : "fail",
				operator: ">",
				threshold: 1,
				actualRatio: ratios.verifierQuality.value,
				reason: hasReplay
					? `${referenceSystem} verifier and qualitative means must both be higher than ${competitor}`
					: `${referenceSystem} verifier mean must be higher than ${competitor}`,
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
		referenceSystem,
		systems: presentSystems,
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
		"# Cross-system comparison",
		"",
		`Model (requested and resolved): \`${comparison.model}\``,
		`Reference system: \`${comparison.referenceSystem}\``,
		"",
		"| system | tasks | quality (mean reward) | qualitative | recovery reads | recovery tokens | wall time | input | output | cache | total tokens | provider cost |",
		"|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
	];
	for (const system of comparison.systems) {
		const total = comparison.totals[system]!;
		lines.push(
			`| ${system} | ${total.tasks} | ${total.meanReward.toFixed(4)} | ${total.meanQualitativeScore?.toFixed(4) ?? "n/a"} | ${total.recoveryReads ?? "n/a"} | ${total.recoveryTokens ?? "n/a"} | ${total.wallSeconds.toFixed(1)}s | ${total.inputTokens} | ${total.outputTokens} | ${total.cacheTokens} | ${total.totalTokens} | ${fmtCost(total)} |`,
		);
	}
	lines.push("", `## ${comparison.referenceSystem} ratios and hard gates`, "");
	lines.push(
		"| competitor | verifier quality | qualitative quality | recovery reads | recovery tokens | time | input | output | cache | total tokens | price | quality gate | time gate | token gate | price gate | overall |",
	);
	lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|---|---|");
	for (const gate of comparison.competitors) {
		lines.push(
			`| ${gate.competitor} | ${fmtRatio(gate.ratios.verifierQuality)} | ${fmtRatio(gate.ratios.qualitativeQuality)} | ${fmtRatio(gate.ratios.recoveryReads)} | ${fmtRatio(gate.ratios.recoveryTokens)} | ${fmtRatio(gate.ratios.wallTime)} | ${fmtRatio(gate.ratios.inputTokens)} | ${fmtRatio(gate.ratios.outputTokens)} | ${fmtRatio(gate.ratios.cacheTokens)} | ${fmtRatio(gate.ratios.totalTokens)} | ${fmtRatio(gate.ratios.price)} | ${gate.quality.status} | ${gate.wallTime.status} | ${gate.totalTokens.status} | ${gate.price.status} | **${gate.overall}** |`,
		);
	}
	lines.push("", `**Overall: ${comparison.overall}.** Unsupported competitor metrics prevent a passing verdict.`, "");

	const headerCols = comparison.systems.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(" | ");
	lines.push(
		"## Paired task outcomes",
		"",
		`| task | repeat | ${headerCols} | replay continuation |`,
		`|---|---:|${comparison.systems.map(() => "---:").join("|")}|---|`,
	);
	for (const pair of comparison.pairs) {
		const cols = comparison.systems.map(s => pair.results[s]?.reward.toFixed(4) ?? "n/a").join(" | ");
		lines.push(`| ${pair.task} | ${pair.repeat} | ${cols} | ${pair.replay?.continuationId ?? "n/a"} |`);
	}
	return `${lines.join("\n")}\n`;
}
