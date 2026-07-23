/** Benchmark adapters normalize native artifacts into manager runs and traces. */
import * as fs from "node:fs";
import * as path from "node:path";
import { aggregate, readJobResult, readTrials } from "./runner";
import type { BenchmarkKind } from "./store";

/** Describes a benchmark metric so storage and UI do not hard-code benchmark semantics. */
export interface MetricDefinition {
	key: string;
	label: string;
	format: "percent" | "number" | "usd";
	higherIsBetter: boolean;
}

/** Adapter metadata exposed to launch clients and the dashboard. */
export interface BenchmarkDefinition {
	kind: BenchmarkKind;
	label: string;
	metrics: MetricDefinition[];
}

/** Built-in benchmark adapters and their native score definitions. */
export const BENCHMARK_DEFINITIONS: BenchmarkDefinition[] = [
	{
		kind: "harbor",
		label: "Harbor",
		metrics: [{ key: "success_rate", label: "Success rate", format: "percent", higherIsBetter: true }],
	},
	{
		kind: "edit",
		label: "TypeScript edit",
		metrics: [
			{ key: "task_success_rate", label: "Task success", format: "percent", higherIsBetter: true },
			{ key: "edit_success_rate", label: "Edit success", format: "percent", higherIsBetter: true },
		],
	},
	{
		kind: "deepswe",
		label: "DeepSWE arms",
		metrics: [
			{ key: "reward_rate", label: "Full reward", format: "percent", higherIsBetter: true },
			{ key: "mean_partial", label: "Mean partial", format: "percent", higherIsBetter: true },
		],
	},
];

/** A normalized trace emitted by any benchmark adapter. */
export interface BenchmarkTrace {
	name: string;
	task: string;
	status: "pass" | "fail" | "error" | "running";
	reward: number | null;
	costUsd: number;
	durationMs: number;
	detail: string;
	tracePath: string | null;
}

/** Uniform aggregate and traces read from benchmark-native artifacts. */
export interface BenchmarkSnapshot {
	traces: BenchmarkTrace[];
	total: number;
	done: number;
	pass: number;
	fail: number;
	error: number;
	running: number;
	costUsd: number;
	tokIn: number;
	tokOut: number;
	tokCache: number;
	score: number | null;
	metrics: Record<string, number | null>;
}

interface EditRun {
	runIndex: number;
	success: boolean;
	error?: string;
	duration: number;
	tokens: { input: number; output: number; reasoning: number };
	toolCalls?: { read: number; edit: number; write: number };
}

interface EditTask {
	id: string;
	name: string;
	runs: EditRun[];
}

interface EditResult {
	tasks: EditTask[];
	summary: {
		totalRuns: number;
		successfulRuns: number;
		taskSuccessRate: number;
		editSuccessRate: number;
		totalTokens: { input: number; output: number };
	};
}

function emptySnapshot(): BenchmarkSnapshot {
	return {
		traces: [],
		total: 0,
		done: 0,
		pass: 0,
		fail: 0,
		error: 0,
		running: 0,
		costUsd: 0,
		tokIn: 0,
		tokOut: 0,
		tokCache: 0,
		score: null,
		metrics: {},
	};
}

function readEditSnapshot(jobDir: string): BenchmarkSnapshot {
	const file = path.join(jobDir, "result.json");
	if (!fs.existsSync(file)) return emptySnapshot();
	const result: EditResult = JSON.parse(fs.readFileSync(file, "utf8"));
	const traces: BenchmarkTrace[] = [];
	let tokIn = 0;
	let tokOut = 0;
	for (const task of result.tasks) {
		for (const run of task.runs) {
			tokIn += run.tokens.input;
			tokOut += run.tokens.output;
			const runNumber = run.runIndex + 1;
			traces.push({
				name: `${task.id}__${runNumber}`,
				task: task.id,
				status: run.success ? "pass" : run.error ? "error" : "fail",
				reward: run.success ? 1 : 0,
				costUsd: 0,
				durationMs: run.duration,
				detail: JSON.stringify({ name: task.name, error: run.error ?? null, tools: run.toolCalls ?? null }),
				tracePath: path.join("result.dump", task.id.replace(/[^a-zA-Z0-9._-]/g, "_"), `run-${runNumber}.md`),
			});
		}
	}
	const pass = traces.filter(trace => trace.status === "pass").length;
	const error = traces.filter(trace => trace.status === "error").length;
	return {
		traces,
		total: result.summary.totalRuns,
		done: traces.length,
		pass,
		// `pass`, `fail`, and `error` are disjoint here, matching `aggregate`'s
		// contract (pass + error + fail === done). Subtract `error` as well as
		// `pass` so errored runs stay out of the plain-fail count; otherwise the
		// shared BenchmarkSnapshot.fail field would count errors for the edit
		// adapter while the harbor adapter excludes them.
		fail: traces.length - pass - error,
		error,
		running: Math.max(0, result.summary.totalRuns - traces.length),
		costUsd: 0,
		tokIn,
		tokOut,
		tokCache: 0,
		score: result.summary.taskSuccessRate,
		metrics: {
			task_success_rate: result.summary.taskSuccessRate,
			edit_success_rate: result.summary.editSuccessRate,
		},
	};
}

interface DeepsweResultRow {
	arm: string;
	task: string;
	reward: number | null;
	partial: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheTokens: number | null;
	costUsd: number | null;
	agentSeconds: number | null;
	toolCalls: Record<string, number> | null;
	error: string | null;
}

interface DeepsweResult {
	model: string;
	arms: string[];
	tasks: string[];
	results: DeepsweResultRow[];
}

/**
 * Normalize deepswe-bench's arms x tasks results.json (see
 * packages/deepswe-bench/run.ts). One trace per (arm, task) cell: full
 * verifier reward is a pass, an execution error is an error, anything else —
 * including a partial reward — is a fail, so pass/fail/error stay disjoint
 * per the shared aggregate contract. The planned grid (arms x tasks) is the
 * total, which keeps `running` honest while the bench is mid-flight.
 */
function readDeepsweSnapshot(jobDir: string): BenchmarkSnapshot {
	const file = path.join(jobDir, "results.json");
	if (!fs.existsSync(file)) return emptySnapshot();
	const result: DeepsweResult = JSON.parse(fs.readFileSync(file, "utf8"));
	let tokIn = 0;
	let tokOut = 0;
	let tokCache = 0;
	let costUsd = 0;
	let partialSum = 0;
	let partialCount = 0;
	const traces: BenchmarkTrace[] = result.results.map(row => {
		tokIn += row.inputTokens ?? 0;
		tokOut += row.outputTokens ?? 0;
		tokCache += row.cacheTokens ?? 0;
		costUsd += row.costUsd ?? 0;
		if (row.partial !== null) {
			partialSum += row.partial;
			partialCount++;
		}
		const status = row.error !== null ? "error" : row.reward !== null && row.reward >= 1 ? "pass" : "fail";
		return {
			name: `${row.task}__${row.arm}`,
			task: row.task,
			status,
			reward: row.reward,
			costUsd: row.costUsd ?? 0,
			durationMs: Math.round((row.agentSeconds ?? 0) * 1000),
			detail: JSON.stringify({ arm: row.arm, partial: row.partial, error: row.error, tools: row.toolCalls }),
			tracePath: null,
		};
	});
	const total = result.arms.length * result.tasks.length;
	const pass = traces.filter(trace => trace.status === "pass").length;
	const error = traces.filter(trace => trace.status === "error").length;
	const done = traces.length;
	return {
		traces,
		total,
		done,
		pass,
		fail: done - pass - error,
		error,
		running: Math.max(0, total - done),
		costUsd,
		tokIn,
		tokOut,
		tokCache,
		score: done > 0 ? pass / done : null,
		metrics: {
			reward_rate: done > 0 ? pass / done : null,
			mean_partial: partialCount > 0 ? partialSum / partialCount : null,
		},
	};
}

/** Read and normalize the latest artifacts for a benchmark run. */
export function readBenchmarkSnapshot(benchmark: BenchmarkKind, jobDir: string): BenchmarkSnapshot {
	if (benchmark === "edit") return readEditSnapshot(jobDir);
	if (benchmark === "deepswe") return readDeepsweSnapshot(jobDir);
	const trials = readTrials(jobDir);
	const job = readJobResult(jobDir);
	const totals = aggregate(trials, job, job?.nTotal ?? trials.length);
	return {
		traces: trials.map(trial => ({
			name: trial.name,
			task: trial.name.replace(/__[^_]+$/, ""),
			status: trial.status,
			reward: trial.reward,
			costUsd: trial.costUsd,
			durationMs: trial.durationMs,
			detail: trial.detail,
			tracePath: path.join(trial.name, "agent", "veyyon.txt"),
		})),
		total: totals.total,
		done: totals.done,
		pass: totals.pass,
		fail: totals.fail,
		error: totals.error,
		running: totals.running,
		costUsd: totals.costUsd,
		tokIn: totals.tokIn,
		tokOut: totals.tokOut,
		tokCache: totals.tokCache,
		score: totals.done > 0 ? totals.pass / totals.done : null,
		metrics: { success_rate: totals.done > 0 ? totals.pass / totals.done : null },
	};
}
