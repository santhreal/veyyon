/**
 * WHY: a trial's status crossed the wire as a bare `string`, and five modules each spelled the
 * union inline and classified it by hand. Two of those classifications disagreed — an arm's `done`
 * count treated an errored trial as decided while the per-task comparison treated it as unrun — and
 * a status none of them listed was decided by nobody: it counted toward no denominator, left the
 * arm's `done` below `nTotal` so the run read as running forever, and rendered in the task matrix
 * with the same shade as a task that had not started.
 *
 * The class closed here: a status this build cannot classify reaching a count, a rate, or a colour.
 * `src/wire.ts` owns the inventory and both classifications — decided (the trial is over) and
 * graded (a verifier produced a verdict) — the store normalises a recorded status it does not know
 * and says what it read, and the matrix keys its colours by the union so a new member fails the
 * dashboard to compile. The inventory is swept at run time and both classifications are pinned by
 * exact equality, so adding a status turns this suite red until someone records its answer.
 *
 * WHAT THIS DOES NOT CATCH: whether a backend produces the right status for a given trial outcome
 * (that is each backend's parser and its own suite), and how a component lays the matrix out.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CELL_CLASS } from "../../dashboard/components/task-matrix";
import {
	isDecidedTrialStatus,
	isGradedTrialStatus,
	isTrialStatus,
	type RunRow,
	TRIAL_STATUSES,
	type TraceRow,
	type TrialStatus,
} from "../../engine/store-shapes";
import { pickMergedTrials, summarizeArm } from "../../store/experiments";
import { RunStore } from "../../store/sqlite";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function traceRow(overrides: Partial<TraceRow>): TraceRow {
	return {
		jobName: "exp-arm",
		name: "task__1",
		task: "task",
		status: "pass",
		reward: 1,
		costUsd: 1,
		durationMs: 60_000,
		detail: "",
		updatedAt: 1,
		tracePath: null,
		...overrides,
	};
}

function runRow(overrides: Partial<RunRow>): RunRow {
	return {
		schemaVersion: 2,
		suite: "terminal-bench@3.0",
		backend: "harbor",
		benchmark: "harbor",
		jobName: "exp-arm",
		experiment: "exp",
		arm: "arm",
		dataset: "d",
		agent: "veyyon",
		models: "m/x",
		label: "",
		prewalk: null,
		config: {},
		role: "",
		note: "",
		status: "running",
		pid: null,
		exitCode: null,
		createdAt: 1,
		finishedAt: null,
		nTotal: 2,
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
		...overrides,
	};
}

/** A harbor job dir with one graded trial, so the store has a real row to read back. */
function writeHarborJob(jobsDir: string, jobName: string): void {
	const jobDir = path.join(jobsDir, jobName);
	fs.mkdirSync(path.join(jobDir, "task__1", "agent"), { recursive: true });
	fs.writeFileSync(
		path.join(jobDir, "result.json"),
		JSON.stringify({ n_total_trials: 1, finished_at: "2026-07-12T11:00:00", stats: {} }),
	);
	fs.writeFileSync(
		path.join(jobDir, "config.json"),
		JSON.stringify({ dataset: "test-dataset@1.0", agents: [{ name: "veyyon", model_name: "m/x" }] }),
	);
	fs.writeFileSync(
		path.join(jobDir, "task__1", "result.json"),
		JSON.stringify({
			started_at: "2026-07-12T10:00:00",
			finished_at: "2026-07-12T10:05:00",
			verifier_result: { rewards: { reward: 1 } },
			agent_result: { cost_usd: 0.5, n_input_tokens: 10, n_output_tokens: 2 },
		}),
	);
}

/** A store over a fresh jobs dir holding `jobName`, plus the db path so a row can be rewritten. */
function storeWithJob(jobName: string): { store: RunStore; dbPath: string } {
	const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-trial-status-"));
	cleanups.push(() => fs.rmSync(jobsDir, { recursive: true, force: true }));
	writeHarborJob(jobsDir, jobName);
	const dbPath = path.join(jobsDir, "evals.sqlite");
	const store = new RunStore(jobsDir, dbPath);
	cleanups.push(() => store.close());
	store.discover();
	store.syncRun(jobName);
	return { store, dbPath };
}

describe("a trial status nothing classifies", () => {
	it("classifies every status the wire declares, and only those", () => {
		const decided = TRIAL_STATUSES.filter(isDecidedTrialStatus);
		const graded = TRIAL_STATUSES.filter(isGradedTrialStatus);

		// Pinned by equality: a new status is unclassified until it is added to one of these.
		expect(decided).toEqual(["pass", "fail", "error"]);
		expect(graded).toEqual(["pass", "fail"]);
		// Graded is strictly narrower than decided; a graded status is always decided.
		expect(graded.every(isDecidedTrialStatus)).toBe(true);
		expect(decided.length).toBeGreaterThan(graded.length);
	});

	it("recognises each declared status and refuses every value that only looks like one", () => {
		for (const status of TRIAL_STATUSES) expect(isTrialStatus(status)).toBe(true);
		for (const value of ["timeout", "cancelled", "skipped", "passed", "PASS", "", " pass", null, undefined, 0, 1]) {
			expect(isTrialStatus(value)).toBe(false);
		}
	});

	it("gives every status its own colour in the task matrix", () => {
		const shades = TRIAL_STATUSES.map(status => CELL_CLASS[status]);
		expect(shades.filter(Boolean)).toHaveLength(TRIAL_STATUSES.length);
		// Two statuses sharing a shade is the same defect as a missing one: the grid stops saying
		// which outcome a cell had.
		expect(new Set(shades).size).toBe(TRIAL_STATUSES.length);
	});

	it("reads a recorded status this build does not know as an error and states what it read", () => {
		const { store, dbPath } = storeWithJob("exp-arm");
		expect(store.listTraces("exp-arm").map(t => t.status)).toEqual(["pass"]);

		const raw = new Database(dbPath);
		raw.query("UPDATE trials SET status = ?, detail = ? WHERE job_name = ?").run("timeout", "killed", "exp-arm");
		raw.close();

		const [trace] = store.listTraces("exp-arm");
		expect(trace.status).toBe("error");
		expect(trace.detail).toBe('recorded status "timeout" is not one this build knows');
		// The row's measurements are not what went wrong, so they survive intact.
		expect(trace.reward).toBe(1);
		expect(trace.costUsd).toBe(0.5);
		expect(isTrialStatus(trace.status)).toBe(true);
	});

	it("counts a normalised trial as decided and out of the pass rate", () => {
		const { store, dbPath } = storeWithJob("exp-arm");
		const raw = new Database(dbPath);
		raw.query("UPDATE trials SET status = ? WHERE job_name = ?").run("what-even-is-this", "exp-arm");
		raw.close();

		const traces = store.listTraces("exp-arm");
		const summary = summarizeArm(runRow({ nTotal: 1 }), traces);
		// Decided, so it is in the denominator; not a pass, so the arm reads 0%.
		expect(summary.passPct).toBe(0);
		expect(traces.filter(t => isDecidedTrialStatus(t.status))).toHaveLength(1);
		expect(traces.filter(t => isGradedTrialStatus(t.status))).toHaveLength(0);
	});

	it("keeps an unmeasured pass rate absent rather than reading a running trial as a failure", () => {
		const summary = summarizeArm(runRow({}), [traceRow({ status: "running", reward: null, costUsd: null })]);
		expect(summary.passPct).toBeNull();
	});

	it("prefers a graded re-run over an error, and never an error over a graded trial", () => {
		const errored = traceRow({ name: "task__1", status: "error", reward: null, updatedAt: 10 });
		const graded = traceRow({ name: "task__1-fix", status: "fail", reward: 0, updatedAt: 5 });
		// The graded trial is older and still wins: decided would have kept the newer error.
		expect(pickMergedTrials([errored, graded]).map(t => t.status)).toEqual(["fail"]);
		expect(pickMergedTrials([graded, errored]).map(t => t.status)).toEqual(["fail"]);

		const laterGraded = traceRow({ name: "task__1-fix", status: "pass", updatedAt: 20 });
		expect(pickMergedTrials([graded, laterGraded]).map(t => t.status)).toEqual(["pass"]);
	});

	it("holds one row per task after a merge, whatever each attempt's status was", () => {
		const attempts: TraceRow[] = TRIAL_STATUSES.map((status: TrialStatus, i) =>
			traceRow({ name: `task__${i}`, task: "task", status, reward: null, updatedAt: i }),
		);
		const merged = pickMergedTrials(attempts);
		expect(merged).toHaveLength(1);
		expect(isTrialStatus(merged[0].status)).toBe(true);
	});
});
