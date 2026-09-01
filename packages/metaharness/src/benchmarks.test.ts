import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BENCHMARK_DEFINITIONS, readBenchmarkSnapshot } from "./benchmarks";

const cleanups: string[] = [];

function jobDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-benchmark-"));
	cleanups.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("benchmark adapters", () => {
	it("normalizes edit attempts, traces, tokens, and declared metrics", () => {
		const dir = jobDir();
		fs.writeFileSync(
			path.join(dir, "result.json"),
			JSON.stringify({
				tasks: [
					{
						id: "rename-symbol",
						name: "Rename symbol",
						runs: [
							{
								runIndex: 0,
								success: true,
								duration: 1200,
								tokens: { input: 100, output: 20, reasoning: 5 },
							},
						],
					},
				],
				summary: {
					totalRuns: 1,
					successfulRuns: 1,
					taskSuccessRate: 1,
					editSuccessRate: 0.75,
					totalTokens: { input: 100, output: 20 },
				},
			}),
		);

		const snapshot = readBenchmarkSnapshot("edit", dir);
		expect(snapshot.metrics).toEqual({ task_success_rate: 1, edit_success_rate: 0.75 });
		expect(snapshot.traces[0]).toMatchObject({
			name: "rename-symbol__1",
			status: "pass",
			tracePath: path.join("result.dump", "rename-symbol", "run-1.md"),
		});
		expect([snapshot.tokIn, snapshot.tokOut]).toEqual([100, 20]);
	});

	// The edit adapter must keep `pass`, `fail`, and `error` disjoint so
	// `pass + error + fail === done`, matching the harbor adapter's `aggregate`
	// contract. A prior `fail: traces.length - pass` folded errored runs into
	// `fail`, so the shared BenchmarkSnapshot.fail field double-counted errors
	// for edit runs while excluding them for harbor runs.
	it("counts errored edit runs as error, not fail", () => {
		const dir = jobDir();
		fs.writeFileSync(
			path.join(dir, "result.json"),
			JSON.stringify({
				tasks: [
					{
						id: "mixed",
						name: "Mixed outcomes",
						runs: [
							{ runIndex: 0, success: true, duration: 10, tokens: { input: 1, output: 1, reasoning: 0 } },
							{ runIndex: 1, success: false, duration: 10, tokens: { input: 1, output: 1, reasoning: 0 } },
							{
								runIndex: 2,
								success: false,
								error: "boom",
								duration: 10,
								tokens: { input: 1, output: 1, reasoning: 0 },
							},
						],
					},
				],
				summary: {
					totalRuns: 3,
					successfulRuns: 1,
					taskSuccessRate: 1 / 3,
					editSuccessRate: 1 / 3,
					totalTokens: { input: 3, output: 3 },
				},
			}),
		);

		const snapshot = readBenchmarkSnapshot("edit", dir);
		expect(snapshot.done).toBe(3);
		expect(snapshot.pass).toBe(1);
		expect(snapshot.error).toBe(1);
		// One plain fail only: the errored run is NOT also counted as a fail.
		expect(snapshot.fail).toBe(1);
		// The disjointness invariant the harbor adapter also upholds.
		expect(snapshot.pass + snapshot.error + snapshot.fail).toBe(snapshot.done);
	});

	it("publishes metric definitions for every managed benchmark", () => {
		expect(BENCHMARK_DEFINITIONS.map(definition => definition.kind)).toEqual(["harbor", "edit", "deepswe"]);
		expect(BENCHMARK_DEFINITIONS.every(definition => definition.metrics.length > 0)).toBe(true);
	});

	/**
	 * ORG-METAHARNESS: deepswe-bench registers as a first-class adapter so its
	 * arms x tasks runs land in the uniform store/dashboard instead of a
	 * parallel runs/ silo. Pins the exact normalization: one trace per
	 * (arm, task) cell, full reward === pass, execution error === error,
	 * partial reward === fail (disjoint counts), the planned grid as `total`
	 * so a mid-flight bench reports honest `running`, and the declared
	 * reward_rate/mean_partial metrics computed from real rows.
	 */
	it("normalizes deepswe arms x tasks results into disjoint traces and grid totals", () => {
		const dir = jobDir();
		fs.writeFileSync(
			path.join(dir, "results.json"),
			JSON.stringify({
				model: "test-model",
				arms: ["baseline", "candidate"],
				tasks: ["task-a", "task-b"],
				results: [
					{
						arm: "baseline",
						task: "task-a",
						reward: 1,
						partial: 1,
						f2p: 1,
						p2p: 1,
						inputTokens: 100,
						outputTokens: 10,
						cacheTokens: 1000,
						costUsd: 0.5,
						agentSeconds: 12.5,
						argotLoadCalls: 0,
						assistantMsgsWithSigil: 0,
						toolCalls: { bash: 3 },
						error: null,
					},
					{
						arm: "candidate",
						task: "task-a",
						reward: 0,
						partial: 0.25,
						f2p: 0.2,
						p2p: 1,
						inputTokens: 50,
						outputTokens: 5,
						cacheTokens: 500,
						costUsd: 0.25,
						agentSeconds: 6,
						argotLoadCalls: 0,
						assistantMsgsWithSigil: 0,
						toolCalls: null,
						error: null,
					},
					{
						arm: "baseline",
						task: "task-b",
						reward: null,
						partial: null,
						f2p: null,
						p2p: null,
						inputTokens: null,
						outputTokens: null,
						cacheTokens: null,
						costUsd: null,
						agentSeconds: null,
						argotLoadCalls: null,
						assistantMsgsWithSigil: null,
						toolCalls: null,
						error: "pier launch failed",
					},
				],
			}),
		);

		const snapshot = readBenchmarkSnapshot("deepswe", dir);
		// Planned grid: 2 arms x 2 tasks; one cell still running.
		expect(snapshot.total).toBe(4);
		expect(snapshot.done).toBe(3);
		expect(snapshot.running).toBe(1);
		// Disjoint outcomes: full reward, partial reward, execution error.
		expect(snapshot.pass).toBe(1);
		expect(snapshot.fail).toBe(1);
		expect(snapshot.error).toBe(1);
		expect(snapshot.pass + snapshot.fail + snapshot.error).toBe(snapshot.done);
		// Real sums, not shapes.
		expect([snapshot.tokIn, snapshot.tokOut, snapshot.tokCache]).toEqual([150, 15, 1500]);
		expect(snapshot.costUsd).toBeCloseTo(0.75);
		expect(snapshot.score).toBeCloseTo(1 / 3);
		expect(snapshot.metrics.reward_rate).toBeCloseTo(1 / 3);
		expect(snapshot.metrics.mean_partial).toBeCloseTo((1 + 0.25) / 2);
		expect(snapshot.traces[0]).toMatchObject({
			name: "task-a__baseline",
			task: "task-a",
			status: "pass",
			reward: 1,
			durationMs: 12500,
		});
		expect(snapshot.traces[2]).toMatchObject({ name: "task-b__baseline", status: "error" });
	});

	it("reports an empty deepswe snapshot before results.json exists (bench still staging)", () => {
		const snapshot = readBenchmarkSnapshot("deepswe", jobDir());
		expect(snapshot.total).toBe(0);
		expect(snapshot.traces).toEqual([]);
		expect(snapshot.score).toBeNull();
	});
});
