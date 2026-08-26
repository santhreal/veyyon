/**
 * WHY: the edit and deepswe snapshot readers cast `JSON.parse` output straight to their result
 * interface and read it inside one `try`. A results file written by another process while the
 * dashboard polls it does not always match that interface: a run row without `tokens`, a task
 * without `runs`, a summary without `totalRuns`. Any one of those threw, the catch returned an
 * empty snapshot, and a finished eval reported zero tasks, no score and no reason — the readable
 * rows beside the broken one were discarded with it. A summary that held a field of the wrong type
 * was worse than an exception: `total` came back `undefined` and `running` came back `NaN`, both on
 * the wire.
 *
 * The class this closes is one malformed row inside an otherwise readable results file, for every
 * registered benchmark kind rather than the one that was reported. Each kind states a fixture
 * below, so a new benchmark turns the sweep red until someone writes one, and the sweep asserts the
 * readable rows survive and the broken row is reported as an error naming what could not be read.
 *
 * What this suite does not catch: a results file whose top level is unreadable is still an empty
 * snapshot, which is honest but silent — nothing tells the operator the file was rejected.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { clearBenchmarkCache, listBenchmarkKinds, readBenchmarkSnapshot } from "../../src/manager/benchmarks";
import type { BenchmarkKind } from "../../src/wire";

const temps: TempDir[] = [];

afterAll(async () => {
	for (const temp of temps.splice(0)) await temp.remove();
});

async function jobDir(): Promise<string> {
	const temp = await TempDir.create("@evals-test-partial-results-");
	temps.push(temp);
	const dir = temp.join("job");
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function writeJson(file: string, body: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(body));
}

/** A job holding two readable rows and one row that states nothing readable. */
interface PartialFixture {
	write(dir: string): void;
}

const FIXTURES: Readonly<Record<BenchmarkKind, PartialFixture>> = {
	harbor: {
		write(dir) {
			writeJson(path.join(dir, "result.json"), {
				n_total_trials: 3,
				stats: { n_running_trials: 0, n_pending_trials: 0 },
			});
			writeJson(path.join(dir, "a__1", "result.json"), {
				verifier_result: { rewards: { reward: 1 } },
				agent_result: { cost_usd: 0.5, n_input_tokens: 10, n_output_tokens: 2 },
			});
			writeJson(path.join(dir, "b__2", "result.json"), {
				verifier_result: { rewards: { reward: 0 } },
				agent_result: { cost_usd: 0.1, n_input_tokens: 4, n_output_tokens: 1 },
			});
			fs.mkdirSync(path.join(dir, "c__3"), { recursive: true });
			fs.writeFileSync(path.join(dir, "c__3", "result.json"), '{"agent_result":');
		},
	},
	edit: {
		write(dir) {
			writeJson(path.join(dir, "result.json"), {
				summary: { totalRuns: 3, successfulRuns: 1, taskSuccessRate: 0.5, editSuccessRate: 0.25 },
				tasks: [
					{
						id: "rename-symbol",
						name: "Rename a symbol",
						runs: [
							{ runIndex: 0, success: true, duration: 12, tokens: { input: 10, output: 2 }, costUsd: 0.5 },
							{ runIndex: 1, success: false, duration: 3, tokens: { input: 4, output: 1 }, costUsd: 0.1 },
							"not a run object",
						],
					},
				],
			});
		},
	},
	deepswe: {
		write(dir) {
			writeJson(path.join(dir, "results.json"), {
				model: "anthropic/claude-opus-4-8",
				arms: ["baseline"],
				tasks: ["t1", "t2", "t3"],
				results: [
					{ arm: "baseline", task: "t1", reward: 1, partial: 1, inputTokens: 10, outputTokens: 2, costUsd: 0.5 },
					{ arm: "baseline", task: "t2", reward: 0, partial: 0.25, inputTokens: 4, outputTokens: 1, costUsd: 0.1 },
					42,
				],
			});
		},
	},
};

describe("a results file with one broken row still reports the rows it can read", () => {
	beforeEach(() => {
		clearBenchmarkCache();
	});

	it("states a fixture for every registered benchmark kind", () => {
		expect([...listBenchmarkKinds()].sort()).toEqual(Object.keys(FIXTURES).sort());
	});

	it.each(Object.keys(FIXTURES) as BenchmarkKind[])("keeps the readable rows of a %s result", async kind => {
		const dir = await jobDir();
		FIXTURES[kind].write(dir);

		const snapshot = readBenchmarkSnapshot(kind, dir);
		const errors = snapshot.traces.filter(trace => trace.status === "error");

		expect(snapshot.traces).toHaveLength(3);
		expect({ pass: snapshot.pass, fail: snapshot.fail, error: snapshot.error, running: snapshot.running }).toEqual({
			pass: 1,
			fail: 1,
			error: 1,
			running: 0,
		});
		expect(snapshot.done).toBe(3);
		expect(errors).toHaveLength(1);
		expect(errors[0].reward).toBeNull();
		expect(errors[0].costUsd).toBeNull();
		expect(snapshot.tokIn).toBe(14);
		expect(snapshot.tokOut).toBe(3);
		expect(snapshot.costUsd).toBeCloseTo(0.6, 5);
	});
});

describe("an edit result states only what it holds", () => {
	beforeEach(() => {
		clearBenchmarkCache();
	});

	it("keeps a run that states no tokens", async () => {
		const dir = await jobDir();
		writeJson(path.join(dir, "result.json"), {
			summary: { totalRuns: 1, taskSuccessRate: 1, editSuccessRate: 1 },
			tasks: [{ id: "t1", name: "T1", runs: [{ runIndex: 0, success: true, duration: 5 }] }],
		});

		const snapshot = readBenchmarkSnapshot("edit", dir);

		expect(snapshot.traces.map(trace => [trace.name, trace.status])).toEqual([["t1__1", "pass"]]);
		expect({ tokIn: snapshot.tokIn, tokOut: snapshot.tokOut, tokCache: snapshot.tokCache }).toEqual({
			tokIn: 0,
			tokOut: 0,
			tokCache: null,
		});
	});

	it("counts its own rows when the summary states no total, and never reports NaN", async () => {
		const dir = await jobDir();
		writeJson(path.join(dir, "result.json"), {
			summary: { successfulRuns: 1 },
			tasks: [{ id: "t1", runs: [{ runIndex: 0, success: true, duration: 5, tokens: { input: 1, output: 1 } }] }],
		});

		const snapshot = readBenchmarkSnapshot("edit", dir);

		expect({ total: snapshot.total, done: snapshot.done, running: snapshot.running }).toEqual({
			total: 1,
			done: 1,
			running: 0,
		});
		expect(snapshot.metrics).toEqual({ task_success_rate: null, edit_success_rate: null });
		expect(snapshot.score).toBeNull();
	});

	it("refuses a rate that is not a number instead of formatting it", async () => {
		const dir = await jobDir();
		writeJson(path.join(dir, "result.json"), {
			summary: { totalRuns: 1, taskSuccessRate: "0.9", editSuccessRate: null },
			tasks: [{ id: "t1", runs: [{ runIndex: 0, success: true, duration: 1, tokens: { input: 1, output: 1 } }] }],
		});

		const snapshot = readBenchmarkSnapshot("edit", dir);

		expect(snapshot.metrics).toEqual({ task_success_rate: null, edit_success_rate: null });
	});

	it("reports a task that states no runs as one error, not as a missing task", async () => {
		const dir = await jobDir();
		writeJson(path.join(dir, "result.json"), {
			summary: { totalRuns: 2 },
			tasks: [
				{ id: "t1", runs: [{ runIndex: 0, success: true, duration: 1, tokens: { input: 1, output: 1 } }] },
				{ id: "t2" },
			],
		});

		const snapshot = readBenchmarkSnapshot("edit", dir);

		expect(snapshot.traces.map(trace => [trace.task, trace.status])).toEqual([
			["t1", "pass"],
			["t2", "error"],
		]);
		expect(snapshot.traces[1].detail).toContain("states no runs");
	});

	it("reads nothing from a file whose tasks are not a list", async () => {
		const dir = await jobDir();
		writeJson(path.join(dir, "result.json"), { summary: { totalRuns: 4 }, tasks: "one task" });

		const snapshot = readBenchmarkSnapshot("edit", dir);

		expect({ total: snapshot.total, done: snapshot.done, traces: snapshot.traces }).toEqual({
			total: 0,
			done: 0,
			traces: [],
		});
	});
});

describe("a deepswe result states only what it holds", () => {
	beforeEach(() => {
		clearBenchmarkCache();
	});

	it("counts its own rows when the grid is absent", async () => {
		const dir = await jobDir();
		writeJson(path.join(dir, "results.json"), {
			model: "m",
			results: [{ arm: "a", task: "t1", reward: 1, partial: 1, inputTokens: 3, outputTokens: 1, costUsd: 0.2 }],
		});

		const snapshot = readBenchmarkSnapshot("deepswe", dir);

		expect({ total: snapshot.total, done: snapshot.done, running: snapshot.running, pass: snapshot.pass }).toEqual({
			total: 1,
			done: 1,
			running: 0,
			pass: 1,
		});
		expect(snapshot.metrics.reward_rate).toBe(1);
	});

	it("averages only the partial rewards that are numbers", async () => {
		const dir = await jobDir();
		writeJson(path.join(dir, "results.json"), {
			arms: ["a"],
			tasks: ["t1", "t2", "t3"],
			results: [
				{ arm: "a", task: "t1", reward: 0, partial: 0.5 },
				{ arm: "a", task: "t2", reward: 0, partial: "0.9" },
				{ arm: "a", task: "t3", reward: 0, partial: null },
			],
		});

		const snapshot = readBenchmarkSnapshot("deepswe", dir);

		expect(snapshot.metrics.mean_partial).toBeCloseTo(0.5, 5);
		expect(snapshot.done).toBe(3);
	});

	it("keeps a grid larger than the rows written so far as the total", async () => {
		const dir = await jobDir();
		writeJson(path.join(dir, "results.json"), {
			arms: ["a", "b"],
			tasks: ["t1", "t2"],
			results: [{ arm: "a", task: "t1", reward: 1 }],
		});

		const snapshot = readBenchmarkSnapshot("deepswe", dir);

		expect({ total: snapshot.total, done: snapshot.done, running: snapshot.running }).toEqual({
			total: 4,
			done: 1,
			running: 3,
		});
	});

	it("reads nothing, and refuses nothing, from a file whose results are not a list", async () => {
		const dir = await jobDir();
		writeJson(path.join(dir, "results.json"), { arms: ["a"], tasks: ["t1"], results: "none" });

		// The manager reads a snapshot on every tick, so an unreadable file states an empty run
		// rather than throwing out of the tick that read it.
		const snapshot = readBenchmarkSnapshot("deepswe", dir);

		expect({ total: snapshot.total, done: snapshot.done, traces: snapshot.traces }).toEqual({
			total: 0,
			done: 0,
			traces: [],
		});
	});
});
