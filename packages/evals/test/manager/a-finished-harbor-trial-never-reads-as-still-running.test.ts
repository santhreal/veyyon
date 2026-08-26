/**
 * WHY: the harbor snapshot reader wrapped a trial's whole read in one `try`, so every failure —
 * a missing `result.json`, a truncated one, one holding an array — landed in the same branch and
 * came back as a *running* trial. A finished run whose last trial wrote a partial file stayed one
 * trial short of its own total forever: the dashboard showed work in progress, the run never
 * reached a terminal count, and the unreadable file was re-parsed on every tick. A `result.json`
 * that parsed to something other than an object was worse: the trial was dropped from the list
 * entirely, so `done` fell below the job's own total with nothing to show for it.
 *
 * The same reader spelled every trace link `agent/veyyon.txt`. Harbor writes `agent/<agent>.txt`,
 * so a run of any other harness linked each trace to a file nothing wrote and the traces route
 * answered `trace not found`.
 *
 * The class this closes is the state of one trial directory as the reader sees it: `result.json`
 * absent, empty, truncated, valid but not an object, valid and terminal; and `agent/` absent,
 * empty, holding one log, holding several, holding no `.txt` at all. Each state is swept below with
 * the status and the trace link it must produce, and the sweep asserts every status the aggregate
 * counts is reached, so a new terminal state has to be given a row.
 *
 * A trial whose verifier recorded no reward graded nothing, so it reads as an error rather than a
 * fail: a fail states a result the run never produced. The runner's own reader of the same file has
 * always said so, and both readers of one `result.json` now agree.
 *
 * What this suite does not catch: it drives the harbor adapter only. The edit and deepswe readers
 * cast `JSON.parse` output to their result shape and still lose a whole run to one malformed row.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { clearBenchmarkCache, getFilesParsedCount, readBenchmarkSnapshot } from "../../src/manager/benchmarks";
import { RunStore } from "../../src/manager/store";

const temps: TempDir[] = [];

afterAll(async () => {
	for (const temp of temps.splice(0)) await temp.remove();
});

async function jobDir(): Promise<string> {
	const temp = await TempDir.create("@evals-test-harbor-snapshot-");
	temps.push(temp);
	const dir = temp.join("job");
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

interface TrialFixture {
	/** `result.json` bytes, or null to leave the file absent. */
	readonly result: string | null;
	/** Files written under `agent/`; an absent key leaves the directory out. */
	readonly agentFiles?: Readonly<Record<string, string>>;
}

function writeTrial(dir: string, name: string, fixture: TrialFixture): void {
	const trialDir = path.join(dir, name);
	fs.mkdirSync(trialDir, { recursive: true });
	if (fixture.result !== null) fs.writeFileSync(path.join(trialDir, "result.json"), fixture.result);
	if (fixture.agentFiles) {
		fs.mkdirSync(path.join(trialDir, "agent"), { recursive: true });
		for (const [file, body] of Object.entries(fixture.agentFiles)) {
			fs.writeFileSync(path.join(trialDir, "agent", file), body);
		}
	}
}

const PASSING_RESULT = JSON.stringify({
	started_at: "2026-07-12T10:00:00",
	finished_at: "2026-07-12T10:05:00",
	verifier_result: { rewards: { reward: 1 } },
	agent_result: { cost_usd: 0.5, n_input_tokens: 100, n_output_tokens: 10 },
});

interface TrialCase {
	readonly label: string;
	readonly fixture: TrialFixture;
	readonly status: "pass" | "fail" | "error" | "running";
	readonly detail: string | null;
	readonly trace: string | null;
}

const TRIAL_CASES: TrialCase[] = [
	{
		label: "no result.json yet",
		fixture: { result: null, agentFiles: { "veyyon.txt": "working\n" } },
		status: "running",
		detail: "",
		trace: "agent/veyyon.txt",
	},
	{
		label: "a result.json truncated mid-write",
		fixture: { result: '{"agent_result": {"cost_usd": 0.5', agentFiles: { "veyyon.txt": "wrote a bit\n" } },
		status: "error",
		detail: "result.json is unreadable:",
		trace: "agent/veyyon.txt",
	},
	{
		label: "an empty result.json",
		fixture: { result: "", agentFiles: { "veyyon.txt": "x\n" } },
		status: "error",
		detail: "result.json is unreadable:",
		trace: "agent/veyyon.txt",
	},
	{
		label: "a result.json holding an array",
		fixture: { result: "[]", agentFiles: { "veyyon.txt": "x\n" } },
		status: "error",
		detail: "result.json holds no trial result object",
		trace: "agent/veyyon.txt",
	},
	{
		label: "a result.json holding null",
		fixture: { result: "null", agentFiles: { "veyyon.txt": "x\n" } },
		status: "error",
		detail: "result.json holds no trial result object",
		trace: "agent/veyyon.txt",
	},
	{
		label: "a terminal result with no reward",
		fixture: { result: JSON.stringify({ agent_result: { cost_usd: 0.1 } }), agentFiles: { "veyyon.txt": "x\n" } },
		status: "error",
		detail: "missing or unparsable reward",
		trace: "agent/veyyon.txt",
	},
	{
		label: "a graded failure",
		fixture: {
			result: JSON.stringify({ verifier_result: { rewards: { reward: 0 } }, agent_result: { cost_usd: 0.1 } }),
			agentFiles: { "veyyon.txt": "x\n" },
		},
		status: "fail",
		detail: "",
		trace: "agent/veyyon.txt",
	},
	{
		label: "a result carrying an exception",
		fixture: {
			result: JSON.stringify({ exception_info: { exception_type: "AgentTimeoutError" } }),
			agentFiles: { "veyyon.txt": "x\n" },
		},
		status: "error",
		detail: "AgentTimeoutError",
		trace: "agent/veyyon.txt",
	},
	{
		label: "a passing result",
		fixture: { result: PASSING_RESULT, agentFiles: { "veyyon.txt": "x\n" } },
		status: "pass",
		detail: "",
		trace: "agent/veyyon.txt",
	},
	{
		label: "an agent that is not veyyon",
		fixture: { result: PASSING_RESULT, agentFiles: { "omp.txt": "omp wrote this\n" } },
		status: "pass",
		detail: "",
		trace: "agent/omp.txt",
	},
	{
		label: "several logs, the largest one named",
		fixture: {
			result: PASSING_RESULT,
			agentFiles: { "debug.txt": "!", "factory.txt": "a much longer transcript\n" },
		},
		status: "pass",
		detail: "",
		trace: "agent/factory.txt",
	},
	{
		label: "no agent directory",
		fixture: { result: PASSING_RESULT },
		status: "pass",
		detail: "",
		trace: null,
	},
	{
		label: "an agent directory with no log",
		fixture: { result: PASSING_RESULT, agentFiles: { "notes.md": "not a log\n" } },
		status: "pass",
		detail: "",
		trace: null,
	},
];

describe("one harbor trial directory reads as the state it is in", () => {
	beforeEach(() => {
		clearBenchmarkCache();
	});

	it.each(TRIAL_CASES)("reads $label", async ({ fixture, status, detail, trace }) => {
		const dir = await jobDir();
		writeTrial(dir, "task-9__abc", fixture);

		const snapshot = readBenchmarkSnapshot("harbor", dir);

		expect(snapshot.traces).toHaveLength(1);
		const [got] = snapshot.traces;
		expect({ status: got.status, trace: got.tracePath }).toEqual({
			status,
			trace: trace === null ? null : path.join("task-9__abc", trace),
		});
		if (detail) expect(got.detail).toContain(detail);
		else expect(got.detail).toBe("");
	});

	it("reaches every status the aggregate counts, so a new one needs a row", async () => {
		const dir = await jobDir();
		for (const [index, testCase] of TRIAL_CASES.entries()) {
			writeTrial(dir, `task-${index}__abc`, testCase.fixture);
		}

		const snapshot = readBenchmarkSnapshot("harbor", dir);
		const seen = new Set(snapshot.traces.map(trace => trace.status));

		expect([...seen].sort()).toEqual(["error", "fail", "pass", "running"]);
		expect(snapshot.pass + snapshot.fail + snapshot.error + snapshot.running).toBe(snapshot.traces.length);
		expect(snapshot.done).toBe(snapshot.traces.length - snapshot.running);
	});

	it("finishes a run whose last trial wrote a partial result", async () => {
		const dir = await jobDir();
		fs.writeFileSync(
			path.join(dir, "result.json"),
			JSON.stringify({ n_total_trials: 3, stats: { n_running_trials: 0, n_pending_trials: 0 } }),
		);
		writeTrial(dir, "a__1", { result: PASSING_RESULT, agentFiles: { "veyyon.txt": "x\n" } });
		writeTrial(dir, "b__2", {
			result: JSON.stringify({ exception_info: { exception_type: "AgentTimeoutError" } }),
			agentFiles: { "veyyon.txt": "x\n" },
		});
		writeTrial(dir, "c__3", { result: '{"agent_result":', agentFiles: { "veyyon.txt": "x\n" } });

		const snapshot = readBenchmarkSnapshot("harbor", dir);

		expect({
			total: snapshot.total,
			done: snapshot.done,
			running: snapshot.running,
			pass: snapshot.pass,
			error: snapshot.error,
		}).toEqual({ total: 3, done: 3, running: 0, pass: 1, error: 2 });
		expect(snapshot.score).toBeCloseTo(1 / 3, 5);
	});

	it("re-reads an unreadable result only when the file changes", async () => {
		const dir = await jobDir();
		writeTrial(dir, "a__1", { result: '{"agent_result":' });

		const first = readBenchmarkSnapshot("harbor", dir);
		const parsedOnce = getFilesParsedCount();
		const second = readBenchmarkSnapshot("harbor", dir);

		expect(first.traces[0].status).toBe("error");
		expect(second.traces[0]).toEqual(first.traces[0]);
		// A file that cannot be parsed is remembered as unreadable, so a tick does not re-read it.
		expect(getFilesParsedCount()).toBe(parsedOnce);

		fs.writeFileSync(path.join(dir, "a__1", "result.json"), PASSING_RESULT);
		const third = readBenchmarkSnapshot("harbor", dir);

		expect(third.traces[0].status).toBe("pass");
	});

	it("stores a trace link that resolves to the log the agent wrote", async () => {
		const temp = await TempDir.create("@evals-test-harbor-trace-link-");
		temps.push(temp);
		const jobsDir = temp.join("jobs");
		const dir = path.join(jobsDir, "omp-run");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "result.json"),
			JSON.stringify({ n_total_trials: 1, stats: { n_running_trials: 0, n_pending_trials: 0 } }),
		);
		fs.writeFileSync(
			path.join(dir, "config.json"),
			JSON.stringify({ dataset: "probe@1.0", agents: [{ name: "omp", model_name: "anthropic/claude-opus-4-8" }] }),
		);
		writeTrial(dir, "task-1__abc", { result: PASSING_RESULT, agentFiles: { "omp.txt": "omp transcript\n" } });

		const store = new RunStore(jobsDir);
		try {
			expect(store.discover()).toBe(1);
			const [trace] = store.listTraces("omp-run");

			expect(trace.tracePath).toBe(path.join("task-1__abc", "agent", "omp.txt"));
			const resolved = path.resolve(dir, trace.tracePath ?? "");
			expect(resolved.startsWith(`${path.resolve(dir)}${path.sep}`)).toBe(true);
			expect(fs.readFileSync(resolved, "utf8")).toBe("omp transcript\n");
		} finally {
			store.close();
		}
	});
});
