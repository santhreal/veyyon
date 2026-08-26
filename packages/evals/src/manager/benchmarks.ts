/** Benchmark adapters normalize native artifacts into manager runs and traces. */
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord } from "@veyyon/utils";
import { aggregate, type JobInfo, type Trial } from "../backends/harbor/runner";
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

let filesParsedCount = 0;

export function getFilesParsedCount(): number {
	return filesParsedCount;
}

export function resetFilesParsedCount(): void {
	filesParsedCount = 0;
}

interface CachedTrial {
	mtimeMs: number;
	size: number;
	trial: Trial;
}

interface CachedJobResult {
	mtimeMs: number;
	size: number;
	job: JobInfo | null;
}

interface CachedSnapshot {
	mtimeMs: number;
	size: number;
	snapshot: BenchmarkSnapshot;
}

const harborTrialCache = new Map<string, CachedTrial>();
const harborJobCache = new Map<string, CachedJobResult>();
const editSnapshotCache = new Map<string, CachedSnapshot>();
const deepsweSnapshotCache = new Map<string, CachedSnapshot>();

export function clearBenchmarkCache(): void {
	harborTrialCache.clear();
	harborJobCache.clear();
	editSnapshotCache.clear();
	deepsweSnapshotCache.clear();
	resetFilesParsedCount();
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
	try {
		const st = fs.statSync(file);
		const cached = editSnapshotCache.get(file);
		if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
			return cached.snapshot;
		}
		const result: EditResult = JSON.parse(fs.readFileSync(file, "utf8"));
		filesParsedCount++;
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
		const snapshot: BenchmarkSnapshot = {
			traces,
			total: result.summary.totalRuns,
			done: traces.length,
			pass,
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
		editSnapshotCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, snapshot });
		return snapshot;
	} catch {
		return emptySnapshot();
	}
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
 * Normalize the DeepSWE suite's arms x tasks results.json (see
 * packages/evals/src/suites/deep-swe/run.ts). One trace per (arm, task) cell: full
 * verifier reward is a pass, an execution error is an error, anything else —
 * including a partial reward — is a fail, so pass/fail/error stay disjoint
 * per the shared aggregate contract. The planned grid (arms x tasks) is the
 * total, which keeps `running` honest while the bench is mid-flight.
 */
function readDeepsweSnapshot(jobDir: string): BenchmarkSnapshot {
	const file = path.join(jobDir, "results.json");
	try {
		const st = fs.statSync(file);
		const cached = deepsweSnapshotCache.get(file);
		if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
			return cached.snapshot;
		}
		const result: DeepsweResult = JSON.parse(fs.readFileSync(file, "utf8"));
		filesParsedCount++;
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
		const snapshot: BenchmarkSnapshot = {
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
		deepsweSnapshotCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, snapshot });
		return snapshot;
	} catch {
		return emptySnapshot();
	}
}

function parseHarborTrialFromJson(raw: unknown, name: string): Trial | null {
	if (!isRecord(raw)) return null;
	const ctxs: Array<Record<string, unknown>> = [];
	if (isRecord(raw.agent_result)) {
		ctxs.push(raw.agent_result);
	}
	if (Array.isArray(raw.step_results)) {
		for (const st of raw.step_results) {
			if (isRecord(st) && isRecord(st.agent_result)) {
				ctxs.push(st.agent_result);
			}
		}
	}
	let costUsd = 0;
	let tokIn = 0;
	let tokOut = 0;
	let tokCache = 0;
	for (const ctx of ctxs) {
		if (typeof ctx.cost_usd === "number" && Number.isFinite(ctx.cost_usd)) costUsd += ctx.cost_usd;
		if (typeof ctx.n_input_tokens === "number" && Number.isFinite(ctx.n_input_tokens)) tokIn += ctx.n_input_tokens;
		if (typeof ctx.n_output_tokens === "number" && Number.isFinite(ctx.n_output_tokens)) {
			tokOut += ctx.n_output_tokens;
		}
		if (typeof ctx.n_cache_tokens === "number" && Number.isFinite(ctx.n_cache_tokens)) tokCache += ctx.n_cache_tokens;
	}

	let rewards: Record<string, number> | null = null;
	if (isRecord(raw.verifier_result) && isRecord(raw.verifier_result.rewards)) {
		rewards = raw.verifier_result.rewards as Record<string, number>;
	}
	if (!rewards && Array.isArray(raw.step_results)) {
		for (const st of raw.step_results) {
			if (isRecord(st) && isRecord(st.verifier_result) && isRecord(st.verifier_result.rewards)) {
				rewards = st.verifier_result.rewards as Record<string, number>;
			}
		}
	}
	let reward: number | null = null;
	if (rewards) {
		const vals = Object.values(rewards).filter((v): v is number => typeof v === "number");
		if (vals.length > 0) {
			reward = typeof rewards.reward === "number" ? rewards.reward : Math.max(...vals);
		}
	}

	const exc = isRecord(raw.exception_info) ? raw.exception_info : null;
	let durationMs = 0;
	const start = typeof raw.started_at === "string" ? Date.parse(raw.started_at) : NaN;
	const end = typeof raw.finished_at === "string" ? Date.parse(raw.finished_at) : NaN;
	if (Number.isFinite(start) && Number.isFinite(end)) durationMs = end - start;

	let status: "pass" | "fail" | "error";
	let detail = "";
	if (exc) {
		status = "error";
		detail = typeof exc.exception_type === "string" ? exc.exception_type : "error";
	} else if (reward !== null && reward >= 1 - 1e-9) {
		status = "pass";
	} else {
		status = "fail";
	}
	return { name, status, reward, costUsd, tokIn, tokOut, tokCache, durationMs, detail };
}

function parseRunningHarborTrial(dir: string, name: string): Trial {
	let started = Date.now();
	try {
		started = fs.statSync(dir).mtimeMs;
	} catch {}
	return {
		name,
		status: "running",
		reward: null,
		costUsd: 0,
		tokIn: 0,
		tokOut: 0,
		tokCache: 0,
		durationMs: Math.max(0, Date.now() - started),
		detail: "",
	};
}

function parseJobInfoFromJson(raw: unknown): JobInfo | null {
	if (!isRecord(raw)) return null;
	const nTotal = typeof raw.n_total_trials === "number" ? raw.n_total_trials : 0;
	let running: number | null = null;
	let pending: number | null = null;
	if (isRecord(raw.stats)) {
		if (typeof raw.stats.n_running_trials === "number") running = raw.stats.n_running_trials;
		if (typeof raw.stats.n_pending_trials === "number") pending = raw.stats.n_pending_trials;
	}
	const finishedRaw = typeof raw.finished_at === "string" ? Date.parse(raw.finished_at) : NaN;
	const finishedAt = Number.isFinite(finishedRaw) ? finishedRaw : null;
	return nTotal > 0 ? { nTotal, running, pending, finishedAt } : null;
}

function readHarborSnapshot(jobDir: string): BenchmarkSnapshot {
	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(jobDir, { withFileTypes: true });
	} catch {
		return emptySnapshot();
	}
	const trials: Trial[] = [];
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		const trialDir = path.join(jobDir, e.name);
		const resultPath = path.join(trialDir, "result.json");
		try {
			const st = fs.statSync(resultPath);
			const cached = harborTrialCache.get(resultPath);
			if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
				trials.push(cached.trial);
			} else {
				const raw = JSON.parse(fs.readFileSync(resultPath, "utf8"));
				filesParsedCount++;
				const trial = parseHarborTrialFromJson(raw, e.name);
				if (trial) {
					harborTrialCache.set(resultPath, { mtimeMs: st.mtimeMs, size: st.size, trial });
					trials.push(trial);
				}
			}
		} catch {
			trials.push(parseRunningHarborTrial(trialDir, e.name));
		}
	}

	const jobResultPath = path.join(jobDir, "result.json");
	let job: JobInfo | null = null;
	try {
		const st = fs.statSync(jobResultPath);
		const cached = harborJobCache.get(jobResultPath);
		if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
			job = cached.job;
		} else {
			const raw = JSON.parse(fs.readFileSync(jobResultPath, "utf8"));
			filesParsedCount++;
			job = parseJobInfoFromJson(raw);
			harborJobCache.set(jobResultPath, { mtimeMs: st.mtimeMs, size: st.size, job });
		}
	} catch {}

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

/** Read and normalize the latest artifacts for a benchmark run. */
export function readBenchmarkSnapshot(benchmark: BenchmarkKind, jobDir: string): BenchmarkSnapshot {
	if (benchmark === "edit") return readEditSnapshot(jobDir);
	if (benchmark === "deepswe") return readDeepsweSnapshot(jobDir);
	return readHarborSnapshot(jobDir);
}
