/**
 * Percentile and aggregate statistics for TypeScript edit benchmark runs.
 *
 * Computes linear percentiles, token distributions, best-run selection, and
 * benchmark summary metrics.
 */

import { meanOfScored, rateOf } from "../../../engine/trial-outcomes";
import type { EditTask } from "../tasks";
import { countEditFailureCategories } from "./retry";
import {
	type BenchmarkConfig,
	type BenchmarkResult,
	type BenchmarkSummary,
	HL_SUBTYPES,
	type SessionTokenStats,
	type TaskResult,
	type TaskRunResult,
	type TokenDistribution,
	type TokenStats,
	type ToolCallStats,
} from "./types";

/**
 * Linear-interpolated percentile (NumPy "linear" / type-7) over an ascending-sorted
 * sample. `p` is a percentage in [0, 100]. Returns 0 for an empty sample.
 */
export function percentile(sortedAscending: readonly number[], p: number): number {
	const n = sortedAscending.length;
	if (n === 0) return 0;
	if (n === 1) return sortedAscending[0]!;
	const rank = (p / 100) * (n - 1);
	const lo = Math.floor(rank);
	const loVal = sortedAscending[lo]!;
	const hi = Math.ceil(rank);
	if (lo === hi) return loVal;
	return loVal + (sortedAscending[hi]! - loVal) * (rank - lo);
}

/** Compute the per-run token distribution (median, p1, p99) across the given runs. */
export function summarizeTokenDistribution(runs: readonly TaskRunResult[]): TokenDistribution {
	const input = runs.map(r => r.tokens.input).sort((a, b) => a - b);
	const output = runs.map(r => r.tokens.output).sort((a, b) => a - b);
	const reasoning = runs.map(r => r.tokens.reasoning).sort((a, b) => a - b);
	const total = runs.map(r => r.tokens.total).sort((a, b) => a - b);
	const at = (p: number): TokenStats => ({
		input: Math.round(percentile(input, p)),
		output: Math.round(percentile(output, p)),
		reasoning: Math.round(percentile(reasoning, p)),
		total: Math.round(percentile(total, p)),
	});
	return { median: at(50), p1: at(1), p99: at(99) };
}

export function diffTokenStats(
	before: SessionTokenStats,
	after: SessionTokenStats,
	systemPromptTokens: number,
): TokenStats {
	// `input` here is the total prompt tokens delivered to the model on the wire,
	// summed across all four buckets the providers expose: non-cached input,
	// cacheRead, cacheWrite. Summing makes the metric comparable across providers
	// with different caching behavior — Anthropic with a hot cache reports its
	// prompt entirely under cacheRead/cacheWrite while non-caching providers put
	// the same content under `input`.
	//
	// The system prompt and tool definitions are constant per-call overhead. We
	// subtract `calls * systemPromptTokens` once per assistant turn so the
	// reported figure reflects task-driven prompt cost rather than fixed boilerplate.
	const calls = Math.max(0, after.assistantMessages - before.assistantMessages);
	const overhead = calls * systemPromptTokens;
	const beforePrompt = before.tokens.input + before.tokens.cacheRead + before.tokens.cacheWrite;
	const afterPrompt = after.tokens.input + after.tokens.cacheRead + after.tokens.cacheWrite;
	const input = Math.max(0, afterPrompt - beforePrompt - overhead);
	const output = Math.max(0, after.tokens.output - before.tokens.output);
	const reasoning = Math.max(0, after.tokens.reasoning - before.tokens.reasoning);
	const total = input + output;
	return { input, output, reasoning, total };
}

export function isTransportFailure(r: TaskRunResult): boolean {
	if (r.success) return false;
	const err = r.error ?? "";
	// Provider/transport stalls retried until the cap was hit. These don't reflect
	// edit-tool quality, so we exclude them from the score denominator.
	return err.includes("Timeout exhausted");
}

export function isGhostRun(r: TaskRunResult): boolean {
	if (r.success) return false;
	const noProgress =
		r.tokens.total === 0 && r.toolCalls.read === 0 && r.toolCalls.edit === 0 && r.toolCalls.write === 0;
	return noProgress || isTransportFailure(r);
}

const EMPTY_TOOL_CALL_STATS: ToolCallStats = {
	read: 0,
	edit: 0,
	write: 0,
	editSuccesses: 0,
	editFailures: 0,
	editWarnings: 0,
	editAutocorrects: 0,
	totalInputChars: 0,
};

/**
 * Strict ordering used to pick the "best" run for a task:
 *   1. Successful runs win over failed runs.
 *   2. Then prefer non-ghost runs (real work over 0/0/0 stalls).
 *   3. Then prefer the run with lower total token usage.
 *   4. Then prefer the earlier runIndex for stability.
 */
export function isBetterRun(a: TaskRunResult, b: TaskRunResult): boolean {
	if (a.success !== b.success) return a.success;
	const aGhost = isGhostRun(a);
	const bGhost = isGhostRun(b);
	if (aGhost !== bGhost) return !aGhost;
	if (a.tokens.total !== b.tokens.total) return a.tokens.total < b.tokens.total;
	return a.runIndex < b.runIndex;
}

export function pickBestRunIndex(orderedRuns: TaskRunResult[]): number {
	if (orderedRuns.length === 0) return -1;
	let bestIdx = 0;
	for (let i = 1; i < orderedRuns.length; i++) {
		if (isBetterRun(orderedRuns[i]!, orderedRuns[bestIdx]!)) bestIdx = i;
	}
	return bestIdx;
}

export function summarizeTaskRuns(task: EditTask, runs: TaskRunResult[]): TaskResult {
	const orderedRuns = runs.slice().sort((a, b) => a.runIndex - b.runIndex);
	const nonGhostRuns = orderedRuns.filter(r => !isGhostRun(r));
	const successfulNonGhost = nonGhostRuns.filter(r => r.success).length;
	const flakeSuccessRate = rateOf(successfulNonGhost, nonGhostRuns.length) ?? 0;
	const bestIdx = pickBestRunIndex(orderedRuns);
	const best = bestIdx === -1 ? undefined : orderedRuns[bestIdx]!;

	const tokens: TokenStats = best ? { ...best.tokens } : { input: 0, output: 0, reasoning: 0, total: 0 };
	const duration = best?.duration ?? 0;
	const indentScore = typeof best?.indentScore === "number" ? best.indentScore : 0;
	const toolCalls: ToolCallStats = best ? { ...best.toolCalls } : { ...EMPTY_TOOL_CALL_STATS };
	const editSuccessRate = toolCalls.edit > 0 ? (rateOf(toolCalls.editSuccesses, toolCalls.edit) ?? 1) : 1;
	const autocorrectFreeSuccess = Boolean(best?.success) && (best?.editAutocorrectCount ?? 0) === 0;

	return {
		id: task.id,
		name: task.name,
		files: task.files,
		runs: orderedRuns,
		bestRunIndex: best?.runIndex ?? -1,
		success: Boolean(best?.success),
		tokens,
		duration,
		indentScore,
		toolCalls,
		editSuccessRate,
		autocorrectFreeSuccess,
		flakeSuccessRate,
	};
}

export function buildBenchmarkResult(params: {
	tasks: EditTask[];
	config: BenchmarkConfig;
	resultsByTask: Map<string, TaskRunResult[]>;
	startTime: string;
	endTime?: string;
}): BenchmarkResult {
	const taskResults = params.tasks.map(task => summarizeTaskRuns(task, params.resultsByTask.get(task.id) ?? []));

	const endTime = params.endTime ?? new Date().toISOString();

	// Diagnostic aggregates run over *every* executed run (across all N) so the
	// report still surfaces ghost/timeout/retry signals.
	const allRuns = taskResults.flatMap(t => t.runs);
	const ghostRuns = allRuns.filter(r => isGhostRun(r)).length;
	const transportFailureRuns = allRuns.filter(r => isTransportFailure(r)).length;
	const nonGhostRuns = allRuns.filter(r => !isGhostRun(r));
	const totalRuns = nonGhostRuns.length;
	const successfulRuns = allRuns.filter(r => r.success).length;
	const timeoutRuns = nonGhostRuns.filter(
		r => r.error?.includes("Timeout") || r.error?.includes("Timeout exhausted"),
	).length;
	const totalTimeoutRetries = nonGhostRuns.reduce((sum, r) => sum + (r.retryStats?.timeoutRetries ?? 0), 0);
	const totalZeroToolRetries = nonGhostRuns.reduce((sum, r) => sum + (r.retryStats?.zeroToolRetries ?? 0), 0);
	const totalProviderFailureRetries = nonGhostRuns.reduce(
		(sum, r) => sum + (r.retryStats?.providerFailureRetries ?? 0),
		0,
	);
	const editFailureCategories = countEditFailureCategories(nonGhostRuns);
	const hashlineEditSubtypes: Record<string, number> | undefined =
		params.config.editVariant === "hashline"
			? Object.fromEntries(
					HL_SUBTYPES.map(key => [key, allRuns.reduce((sum, r) => sum + (r.hashlineEditSubtypes?.[key] ?? 0), 0)]),
				)
			: undefined;

	// Primary aggregates run over the *best* run of each completed task.
	const bestRuns: TaskRunResult[] = [];
	for (const task of taskResults) {
		if (task.bestRunIndex < 0) continue;
		const best = task.runs.find(r => r.runIndex === task.bestRunIndex);
		if (best) bestRuns.push(best);
	}
	const tasksWithBestRun = bestRuns.length;
	const totalTasks = params.tasks.length;
	const denom = totalTasks || 1;

	const successfulTasks = taskResults.filter(t => t.success).length;
	const consistentlyPassingTasks = taskResults.filter(
		t => t.success && t.runs.filter(r => !isGhostRun(r)).every(r => r.success),
	).length;
	const flakyTasks = taskResults.filter(
		t => t.success && t.runs.filter(r => !isGhostRun(r)).some(r => !r.success),
	).length;

	const totalTokens: TokenStats = {
		input: bestRuns.reduce((sum, r) => sum + r.tokens.input, 0),
		output: bestRuns.reduce((sum, r) => sum + r.tokens.output, 0),
		reasoning: bestRuns.reduce((sum, r) => sum + r.tokens.reasoning, 0),
		total: bestRuns.reduce((sum, r) => sum + r.tokens.total, 0),
	};
	const tokenDistribution = summarizeTokenDistribution(bestRuns);
	const totalDuration = bestRuns.reduce((sum, r) => sum + r.duration, 0);
	const totalToolCalls: ToolCallStats = {
		read: bestRuns.reduce((sum, r) => sum + r.toolCalls.read, 0),
		edit: bestRuns.reduce((sum, r) => sum + r.toolCalls.edit, 0),
		write: bestRuns.reduce((sum, r) => sum + r.toolCalls.write, 0),
		editSuccesses: bestRuns.reduce((sum, r) => sum + r.toolCalls.editSuccesses, 0),
		editFailures: bestRuns.reduce((sum, r) => sum + r.toolCalls.editFailures, 0),
		editWarnings: bestRuns.reduce((sum, r) => sum + r.toolCalls.editWarnings, 0),
		editAutocorrects: bestRuns.reduce((sum, r) => sum + r.toolCalls.editAutocorrects, 0),
		totalInputChars: bestRuns.reduce((sum, r) => sum + r.toolCalls.totalInputChars, 0),
	};
	const bestIndentScores = bestRuns
		.map(r => r.indentScore)
		.filter((score): score is number => typeof score === "number");
	const avgIndentScore = meanOfScored(bestIndentScores) ?? 0;

	const editSuccessRate =
		totalToolCalls.edit > 0 ? (rateOf(totalToolCalls.editSuccesses, totalToolCalls.edit) ?? 1) : 1;
	const autocorrectFreeSuccessfulTasks = bestRuns.filter(r => r.success && r.editAutocorrectCount === 0).length;
	const autocorrectedBestRuns = bestRuns.filter(r => r.editAutocorrectCount > 0).length;
	const editAutocorrectRate =
		totalToolCalls.editSuccesses > 0
			? (rateOf(totalToolCalls.editAutocorrects, totalToolCalls.editSuccesses) ?? 0)
			: 0;
	const bestWithMutationIntent = bestRuns.filter(r => typeof r.mutationIntentMatched === "boolean");
	const mutationIntentMatchRate =
		bestWithMutationIntent.length > 0
			? (rateOf(bestWithMutationIntent.filter(r => r.mutationIntentMatched).length, bestWithMutationIntent.length) ??
				undefined)
			: undefined;

	const oneShotSuccessRuns = taskResults
		.map(t => t.runs.find(r => r.runIndex === 0))
		.filter((r): r is TaskRunResult => Boolean(r?.success));
	const successfulOneShotTasks = oneShotSuccessRuns.length;
	const oneShotDenom = successfulOneShotTasks || 1;

	const totalOneShotSuccessTokens: TokenStats = {
		input: oneShotSuccessRuns.reduce((sum, r) => sum + r.tokens.input, 0),
		output: oneShotSuccessRuns.reduce((sum, r) => sum + r.tokens.output, 0),
		reasoning: oneShotSuccessRuns.reduce((sum, r) => sum + r.tokens.reasoning, 0),
		total: oneShotSuccessRuns.reduce((sum, r) => sum + r.tokens.total, 0),
	};
	const oneShotTokenDistribution = summarizeTokenDistribution(oneShotSuccessRuns);

	const taskDenom = tasksWithBestRun || 1;
	const summary: BenchmarkSummary = {
		successfulOneShotTasks,
		totalOneShotSuccessTokens,
		avgOneShotSuccessTokensPerTask: {
			input: Math.round(totalOneShotSuccessTokens.input / oneShotDenom),
			output: Math.round(totalOneShotSuccessTokens.output / oneShotDenom),
			reasoning: Math.round(totalOneShotSuccessTokens.reasoning / oneShotDenom),
			total: Math.round(totalOneShotSuccessTokens.total / oneShotDenom),
		},
		medianOneShotSuccessTokensPerTask: oneShotTokenDistribution.median,
		p1OneShotSuccessTokensPerTask: oneShotTokenDistribution.p1,
		p99OneShotSuccessTokensPerTask: oneShotTokenDistribution.p99,
		totalTasks,
		totalRuns,
		successfulRuns,
		successfulTasks,
		taskSuccessRate: rateOf(successfulTasks, denom) ?? 0,
		flakyTasks,
		consistentlyPassingTasks,
		totalTokens,
		avgTokensPerTask: {
			input: Math.round(totalTokens.input / taskDenom),
			output: Math.round(totalTokens.output / taskDenom),
			reasoning: Math.round(totalTokens.reasoning / taskDenom),
			total: Math.round(totalTokens.total / taskDenom),
		},
		medianTokensPerTask: tokenDistribution.median,
		p1TokensPerTask: tokenDistribution.p1,
		p99TokensPerTask: tokenDistribution.p99,
		totalDuration,
		avgDurationPerTask: Math.round(totalDuration / taskDenom),
		avgIndentScore,
		totalToolCalls,
		avgToolCallsPerTask: {
			read: totalToolCalls.read / taskDenom,
			edit: totalToolCalls.edit / taskDenom,
			write: totalToolCalls.write / taskDenom,
			editSuccesses: totalToolCalls.editSuccesses / taskDenom,
			editFailures: totalToolCalls.editFailures / taskDenom,
			editWarnings: totalToolCalls.editWarnings / taskDenom,
			editAutocorrects: totalToolCalls.editAutocorrects / taskDenom,
			totalInputChars: totalToolCalls.totalInputChars / taskDenom,
		},
		editSuccessRate,
		autocorrectFreeSuccessfulTasks,
		autocorrectFreeSuccessRate: rateOf(autocorrectFreeSuccessfulTasks, denom) ?? 0,
		autocorrectedBestRuns,
		editAutocorrectRate,
		timeoutRuns,
		totalTimeoutRetries,
		totalZeroToolRetries,
		totalProviderFailureRetries,
		ghostRuns,
		transportFailureRuns,
		mutationIntentMatchRate,
		editFailureCategories,
		hashlineEditSubtypes,
	};

	return {
		config: params.config,
		tasks: taskResults,
		summary,
		startTime: params.startTime,
		endTime,
	};
}
