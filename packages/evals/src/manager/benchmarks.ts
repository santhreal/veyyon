/** Benchmark adapters normalize native artifacts into manager runs and traces. */
import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage, isRecord } from "@veyyon/utils";
import { aggregate, type JobInfo } from "../backends/harbor/runner/results";
import { sumOfMeasured } from "../core/scoring";
import type { BackendId } from "../core/types";
import { pathSegmentFrom } from "../paths";
import type { BenchmarkDefinition, BenchmarkKind, MetricDefinition } from "../wire";

/** Adapter for a benchmark system, declaring its wire metadata, backend binding, and snapshot reader. */
export interface BenchmarkAdapter {
	readonly kind: BenchmarkKind;
	readonly label: string;
	readonly backend: BackendId;
	readonly metrics: readonly MetricDefinition[];
	readSnapshot(jobDir: string): BenchmarkSnapshot;
}

export class BenchmarkNotFoundError extends Error {
	constructor(kind: string, available: readonly string[]) {
		const formatted = available.length > 0 ? available.join(", ") : "(none)";
		super(`Unknown benchmark adapter "${kind}". Registered benchmarks: ${formatted}`);
		this.name = "BenchmarkNotFoundError";
	}
}

export class DuplicateBenchmarkRegistrationError extends Error {
	constructor(kind: string) {
		super(`Benchmark adapter "${kind}" is already registered.`);
		this.name = "DuplicateBenchmarkRegistrationError";
	}
}

export class BenchmarkRegistry {
	#benchmarks = new Map<string, BenchmarkAdapter>();

	register(benchmark: BenchmarkAdapter): void {
		if (this.#benchmarks.has(benchmark.kind)) {
			throw new DuplicateBenchmarkRegistrationError(benchmark.kind);
		}
		this.#benchmarks.set(benchmark.kind, benchmark);
	}

	get(kind: string): BenchmarkAdapter | undefined {
		return this.#benchmarks.get(kind);
	}

	getByBackend(backend: BackendId): BenchmarkAdapter | undefined {
		for (const adapter of this.#benchmarks.values()) {
			if (adapter.backend === backend) return adapter;
		}
		return undefined;
	}

	has(kind: string): boolean {
		return this.#benchmarks.has(kind);
	}

	list(): readonly BenchmarkAdapter[] {
		return [...this.#benchmarks.values()];
	}

	listKinds(): readonly BenchmarkKind[] {
		return [...this.#benchmarks.keys()];
	}

	listDefinitions(): readonly BenchmarkDefinition[] {
		return [...this.#benchmarks.values()].map(b => ({
			kind: b.kind,
			label: b.label,
			metrics: [...b.metrics],
		}));
	}

	require(kind: string): BenchmarkAdapter {
		const benchmark = this.#benchmarks.get(kind);
		if (!benchmark) {
			throw new BenchmarkNotFoundError(kind, this.listKinds());
		}
		return benchmark;
	}

	unregister(kind: string): boolean {
		return this.#benchmarks.delete(kind);
	}

	clear(): void {
		this.#benchmarks.clear();
	}
}

export const defaultBenchmarkRegistry = new BenchmarkRegistry();

export function registerBenchmark(adapter: BenchmarkAdapter): void {
	defaultBenchmarkRegistry.register(adapter);
}

export function getBenchmark(kind: string): BenchmarkAdapter | undefined {
	return defaultBenchmarkRegistry.get(kind);
}

export function getBenchmarkByBackend(backend: BackendId): BenchmarkAdapter | undefined {
	return defaultBenchmarkRegistry.getByBackend(backend);
}

export function hasBenchmark(kind: string): boolean {
	return defaultBenchmarkRegistry.has(kind);
}

export function listBenchmarks(): readonly BenchmarkAdapter[] {
	return defaultBenchmarkRegistry.list();
}

export function listBenchmarkKinds(): readonly BenchmarkKind[] {
	return defaultBenchmarkRegistry.listKinds();
}

export function listBenchmarkDefinitions(): readonly BenchmarkDefinition[] {
	return defaultBenchmarkRegistry.listDefinitions();
}

export function requireBenchmark(kind: string): BenchmarkAdapter {
	return defaultBenchmarkRegistry.require(kind);
}

export function unregisterBenchmark(kind: string): boolean {
	return defaultBenchmarkRegistry.unregister(kind);
}

export function clearBenchmarkRegistry(): void {
	defaultBenchmarkRegistry.clear();
}

export const BUILTIN_BENCHMARKS: readonly BenchmarkAdapter[] = [
	{
		kind: "harbor",
		label: "Harbor",
		backend: "harbor",
		metrics: [{ key: "success_rate", label: "Success rate", format: "percent", higherIsBetter: true }],
		readSnapshot: readHarborSnapshot,
	},
	{
		kind: "edit",
		label: "TypeScript edit",
		backend: "in-process",
		metrics: [
			{ key: "task_success_rate", label: "Task success", format: "percent", higherIsBetter: true },
			{ key: "edit_success_rate", label: "Edit success", format: "percent", higherIsBetter: true },
		],
		readSnapshot: readEditSnapshot,
	},
	{
		kind: "deepswe",
		label: "DeepSWE arms",
		backend: "pier",
		metrics: [
			{ key: "reward_rate", label: "Full reward", format: "percent", higherIsBetter: true },
			{ key: "mean_partial", label: "Mean partial", format: "percent", higherIsBetter: true },
		],
		readSnapshot: readDeepsweSnapshot,
	},
];

export function registerBuiltinBenchmarks(registry?: BenchmarkRegistry): void {
	const target = registry ?? defaultBenchmarkRegistry;
	for (const adapter of BUILTIN_BENCHMARKS) {
		if (!target.has(adapter.kind)) {
			target.register(adapter);
		}
	}
}

registerBuiltinBenchmarks();

/** A normalized trace emitted by any benchmark adapter. */
export interface BenchmarkTrace {
	name: string;
	task: string;
	status: "pass" | "fail" | "error" | "running";
	reward: number | null;
	costUsd: number | null;
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
	costUsd: number | null;
	tokIn: number;
	tokOut: number;
	tokCache: number | null;
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
	trial: HarborParsedTrial;
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
/**
 * A finite number, or null.
 *
 * A results file is written by another process and read while it is still being written, so every
 * field it states is checked here. Casting the parsed JSON to a result interface made one absent
 * field an exception, and the exception erased the whole run: an eval that finished reported zero
 * tasks and no score, with nothing saying why.
 */
function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A finite number as a whole count >= 0, or null. */
function countOf(value: unknown): number | null {
	const n = finiteNumber(value);
	return n !== null && n >= 0 ? Math.trunc(n) : null;
}

/** One normalized row of an edit result, or null when the row states nothing readable. */
function readEditRun(raw: unknown, taskId: string, index: number): BenchmarkTrace {
	const runNumber = (isRecord(raw) ? countOf(raw.runIndex) : null) ?? index;
	const name = `${taskId}__${runNumber + 1}`;
	if (!isRecord(raw)) {
		return unreadableTrace(name, taskId, "run entry is not an object");
	}
	const tokens = isRecord(raw.tokens) ? raw.tokens : {};
	const error = typeof raw.error === "string" && raw.error ? raw.error : null;
	return {
		name,
		task: taskId,
		status: raw.success === true ? "pass" : error ? "error" : "fail",
		reward: raw.success === true ? 1 : 0,
		costUsd: finiteNumber(raw.costUsd),
		durationMs: finiteNumber(raw.duration) ?? 0,
		detail: JSON.stringify({
			name: typeof raw.name === "string" ? raw.name : taskId,
			error,
			tools: isRecord(raw.toolCalls) ? raw.toolCalls : null,
			tokIn: countOf(tokens.input) ?? 0,
			tokOut: countOf(tokens.output) ?? 0,
			cache: countOf(tokens.cache),
		}),
		tracePath: path.join("result.dump", pathSegmentFrom(taskId, "task"), `run-${runNumber + 1}.md`),
	};
}

/** A row that states nothing readable is an error naming what could not be read, never a pass. */
function unreadableTrace(name: string, task: string, reason: string): BenchmarkTrace {
	return {
		name,
		task,
		status: "error",
		reward: null,
		costUsd: null,
		durationMs: 0,
		detail: JSON.stringify({ error: reason }),
		tracePath: null,
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
		costUsd: null,
		tokIn: 0,
		tokOut: 0,
		tokCache: null,
		score: null,
		metrics: {},
	};
}

function readEditSnapshot(jobDir: string): BenchmarkSnapshot {
	const file = path.join(jobDir, "result.json");
	let raw: unknown;
	let st: fs.Stats;
	try {
		st = fs.statSync(file);
		const cached = editSnapshotCache.get(file);
		if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
			return cached.snapshot;
		}
		const text = fs.readFileSync(file, "utf8");
		filesParsedCount++;
		raw = JSON.parse(text);
	} catch {
		return emptySnapshot();
	}
	if (!isRecord(raw) || !Array.isArray(raw.tasks)) return emptySnapshot();

	const traces: BenchmarkTrace[] = [];
	let tokIn = 0;
	let tokOut = 0;
	const caches: (number | null)[] = [];
	for (const [taskIndex, rawTask] of raw.tasks.entries()) {
		if (!isRecord(rawTask)) {
			traces.push(unreadableTrace(`task-${taskIndex}`, `task-${taskIndex}`, "task entry is not an object"));
			continue;
		}
		const taskId = typeof rawTask.id === "string" && rawTask.id ? rawTask.id : `task-${taskIndex}`;
		if (!Array.isArray(rawTask.runs)) {
			traces.push(unreadableTrace(taskId, taskId, "task states no runs"));
			continue;
		}
		for (const [runIndex, rawRun] of rawTask.runs.entries()) {
			const trace = readEditRun(rawRun, taskId, runIndex);
			traces.push(trace);
			if (isRecord(rawRun)) {
				const tokens = isRecord(rawRun.tokens) ? rawRun.tokens : {};
				tokIn += countOf(tokens.input) ?? 0;
				tokOut += countOf(tokens.output) ?? 0;
				if (tokens.cache !== undefined) caches.push(countOf(tokens.cache));
			}
		}
	}

	const summary = isRecord(raw.summary) ? raw.summary : {};
	const pass = traces.filter(trace => trace.status === "pass").length;
	const error = traces.filter(trace => trace.status === "error").length;
	const total = countOf(summary.totalRuns) ?? traces.length;
	const snapshot: BenchmarkSnapshot = {
		traces,
		total,
		done: traces.length,
		pass,
		fail: traces.length - pass - error,
		error,
		running: Math.max(0, total - traces.length),
		costUsd: sumOfMeasured(traces.map(trace => trace.costUsd)),
		tokIn,
		tokOut,
		tokCache: sumOfMeasured(caches),
		score: finiteNumber(summary.taskSuccessRate),
		metrics: {
			task_success_rate: finiteNumber(summary.taskSuccessRate),
			edit_success_rate: finiteNumber(summary.editSuccessRate),
		},
	};
	editSnapshotCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, snapshot });
	return snapshot;
}

/**
 * Normalize the DeepSWE suite's arms x tasks results.json (see
 * packages/evals/src/suites/deep-swe/run.ts). One trace per (arm, task) cell: full
 * verifier reward is a pass, an execution error is an error, anything else —
 * including a partial reward — is a fail, so pass/fail/error stay disjoint
 * per the shared aggregate contract. The planned grid (arms x tasks) is the
 * total, which keeps `running` honest while the bench is mid-flight. A row that
 * states nothing readable is one error, never the loss of every other row.
 */
function readDeepsweSnapshot(jobDir: string): BenchmarkSnapshot {
	const file = path.join(jobDir, "results.json");
	let raw: unknown;
	let st: fs.Stats;
	try {
		st = fs.statSync(file);
		const cached = deepsweSnapshotCache.get(file);
		if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
			return cached.snapshot;
		}
		const text = fs.readFileSync(file, "utf8");
		filesParsedCount++;
		raw = JSON.parse(text);
	} catch {
		return emptySnapshot();
	}
	if (!isRecord(raw) || !Array.isArray(raw.results)) return emptySnapshot();

	let tokIn = 0;
	let tokOut = 0;
	let partialSum = 0;
	let partialCount = 0;
	const costs: (number | null)[] = [];
	const caches: (number | null)[] = [];
	const traces: BenchmarkTrace[] = raw.results.map((row, index) => {
		if (!isRecord(row)) return unreadableTrace(`row-${index}`, `row-${index}`, "result row is not an object");
		const task = typeof row.task === "string" && row.task ? row.task : `row-${index}`;
		const arm = typeof row.arm === "string" ? row.arm : "";
		tokIn += countOf(row.inputTokens) ?? 0;
		tokOut += countOf(row.outputTokens) ?? 0;
		costs.push(finiteNumber(row.costUsd));
		caches.push(countOf(row.cacheTokens));
		const partial = finiteNumber(row.partial);
		if (partial !== null) {
			partialSum += partial;
			partialCount++;
		}
		const error = typeof row.error === "string" && row.error ? row.error : null;
		const reward = finiteNumber(row.reward);
		return {
			name: `${task}__${arm}`,
			task,
			status: error !== null ? "error" : reward !== null && reward >= 1 ? "pass" : "fail",
			reward,
			costUsd: finiteNumber(row.costUsd),
			durationMs: Math.round((finiteNumber(row.agentSeconds) ?? 0) * 1000),
			detail: JSON.stringify({ arm, partial, error, tools: isRecord(row.toolCalls) ? row.toolCalls : null }),
			tracePath: null,
		};
	});
	const armCount = Array.isArray(raw.arms) ? raw.arms.length : 0;
	const taskCount = Array.isArray(raw.tasks) ? raw.tasks.length : 0;
	const done = traces.length;
	const total = Math.max(armCount * taskCount, done);
	const pass = traces.filter(trace => trace.status === "pass").length;
	const error = traces.filter(trace => trace.status === "error").length;
	const snapshot: BenchmarkSnapshot = {
		traces,
		total,
		done,
		pass,
		fail: done - pass - error,
		error,
		running: Math.max(0, total - done),
		costUsd: sumOfMeasured(costs),
		tokIn,
		tokOut,
		tokCache: sumOfMeasured(caches),
		score: done > 0 ? pass / done : null,
		metrics: {
			reward_rate: done > 0 ? pass / done : null,
			mean_partial: partialCount > 0 ? partialSum / partialCount : null,
		},
	};
	deepsweSnapshotCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, snapshot });
	return snapshot;
}

interface HarborParsedTrial {
	name: string;
	status: "pass" | "fail" | "error" | "running";
	reward: number | null;
	costUsd: number | null;
	tokIn: number;
	tokOut: number;
	tokCache: number | null;
	durationMs: number;
	detail: string;
	/** Job-relative path to the agent's own log, or null when the trial wrote none. */
	tracePath: string | null;
}

/**
 * The agent's log inside one harbor trial directory, as a job-relative path.
 *
 * Harbor writes `agent/<agent name>.txt`, and a trial's `result.json` does not record which agent
 * produced it, so the file is read from the directory rather than assumed. A hardcoded
 * `agent/veyyon.txt` pointed every trace of an omp, factory or hermes run at a file none of them
 * writes, and the traces route answered `trace not found`. The largest log wins, then the first by
 * name, so a directory holding more than one file resolves the same way on every tick.
 */
function findAgentLogPath(jobDir: string, trialName: string): string | null {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(path.join(jobDir, trialName, "agent"), { withFileTypes: true });
	} catch {
		return null;
	}
	const logs: Array<{ name: string; size: number }> = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".txt")) continue;
		let size = 0;
		try {
			size = fs.statSync(path.join(jobDir, trialName, "agent", entry.name)).size;
		} catch {
			/* a log that vanished mid-read sorts last */
		}
		logs.push({ name: entry.name, size });
	}
	if (logs.length === 0) return null;
	logs.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
	return path.join(trialName, "agent", logs[0].name);
}

function parseHarborTrialFromJson(raw: unknown, name: string, tracePath: string | null): HarborParsedTrial | null {
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
	let tokIn = 0;
	let tokOut = 0;
	const costs: (number | null)[] = [];
	const caches: (number | null)[] = [];
	for (const ctx of ctxs) {
		if (typeof ctx.cost_usd === "number" && Number.isFinite(ctx.cost_usd)) {
			costs.push(ctx.cost_usd);
		}
		if (typeof ctx.n_input_tokens === "number" && Number.isFinite(ctx.n_input_tokens)) {
			tokIn += ctx.n_input_tokens;
		}
		if (typeof ctx.n_output_tokens === "number" && Number.isFinite(ctx.n_output_tokens)) {
			tokOut += ctx.n_output_tokens;
		}
		if (typeof ctx.n_cache_tokens === "number" && Number.isFinite(ctx.n_cache_tokens)) {
			caches.push(ctx.n_cache_tokens);
		}
	}
	const costUsd = sumOfMeasured(costs);
	const tokCache = sumOfMeasured(caches);

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
	} else if (reward === null) {
		// A verifier that recorded no reward graded nothing. Reading that as a fail states a result the
		// run never produced, and puts it in the denominator of the pass rate. The runner's own reader
		// of the same result.json calls it an error; both readers of one file report the same thing.
		status = "error";
		detail = "missing or unparsable reward";
	} else if (reward >= 1 - 1e-9) {
		status = "pass";
	} else {
		status = "fail";
	}
	return { name, status, reward, costUsd, tokIn, tokOut, tokCache, durationMs, detail, tracePath };
}

function parseRunningHarborTrial(dir: string, name: string, tracePath: string | null): HarborParsedTrial {
	let started = Date.now();
	try {
		started = fs.statSync(dir).mtimeMs;
	} catch {}
	return {
		name,
		status: "running",
		reward: null,
		costUsd: null,
		tokIn: 0,
		tokOut: 0,
		tokCache: null,
		durationMs: Math.max(0, Date.now() - started),
		detail: "",
		tracePath,
	};
}

/**
 * A trial whose `result.json` exists and cannot be read is an error, never a running trial.
 *
 * Reporting it as running kept a finished run permanently short of its own total: the dashboard
 * showed a trial still working, the run never reached a terminal count, and the truncated file was
 * re-read on every tick.
 */
function unreadableHarborTrial(name: string, tracePath: string | null, detail: string): HarborParsedTrial {
	return {
		name,
		status: "error",
		reward: null,
		costUsd: null,
		tokIn: 0,
		tokOut: 0,
		tokCache: null,
		durationMs: 0,
		detail,
		tracePath,
	};
}

function readFinishedHarborTrial(resultPath: string, name: string, tracePath: string | null): HarborParsedTrial {
	let raw: unknown;
	try {
		const text = fs.readFileSync(resultPath, "utf8");
		// The read counts as work done even when the parse fails, so a cached unreadable result is
		// observable as a file this reader stopped touching.
		filesParsedCount++;
		raw = JSON.parse(text);
	} catch (error) {
		return unreadableHarborTrial(name, tracePath, `result.json is unreadable: ${errorMessage(error)}`);
	}
	return (
		parseHarborTrialFromJson(raw, name, tracePath) ??
		unreadableHarborTrial(name, tracePath, "result.json holds no trial result object")
	);
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
	const trials: HarborParsedTrial[] = [];
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		const trialDir = path.join(jobDir, e.name);
		const resultPath = path.join(trialDir, "result.json");
		const tracePath = findAgentLogPath(jobDir, e.name);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(resultPath);
		} catch {
			// No result yet: the trial is still working, which is the only reading of a missing file.
			trials.push(parseRunningHarborTrial(trialDir, e.name, tracePath));
			continue;
		}
		const cached = harborTrialCache.get(resultPath);
		if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
			trials.push(cached.trial);
			continue;
		}
		const trial = readFinishedHarborTrial(resultPath, e.name, tracePath);
		harborTrialCache.set(resultPath, { mtimeMs: stat.mtimeMs, size: stat.size, trial });
		trials.push(trial);
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
			tracePath: trial.tracePath,
		})),
		total: totals.total,
		done: totals.done,
		pass: totals.pass,
		fail: totals.fail,
		error: totals.error,
		running: totals.running,
		costUsd: totals.costUsd,
		// Every harbor trial this reader parses counts its own tokens, so an absent sum means it read
		// no trial at all — and no trial is a measured zero, unlike an unpriced one.
		tokIn: totals.tokIn ?? 0,
		tokOut: totals.tokOut ?? 0,
		tokCache: totals.tokCache,
		score: totals.done > 0 ? totals.pass / totals.done : null,
		metrics: { success_rate: totals.done > 0 ? totals.pass / totals.done : null },
	};
}

/** Read and normalize the latest artifacts for a benchmark run. */
export function readBenchmarkSnapshot(benchmark: BenchmarkKind, jobDir: string): BenchmarkSnapshot {
	return requireBenchmark(benchmark).readSnapshot(jobDir);
}
