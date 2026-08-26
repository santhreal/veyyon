/**
 * WHY:
 * When benchmark runs don't track or measure spend, adapters used to emit `costUsd: 0`
 * (or `+= row.costUsd ?? 0`), making the dashboard report `$0.00` for runs that spent
 * money. Spend and cache tokens must be `null` when unmeasured, exact sums when all measured,
 * and the sum of measured ones when partially measured.
 *
 * This test drives every benchmark adapter supported by BENCHMARK_DEFINITIONS over real
 * fixture directories to verify that unknown spend is never reported as zero.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listBenchmarkKinds, readBenchmarkSnapshot } from "../../src/manager/benchmarks";
import type { BenchmarkKind } from "../../src/wire";

const cleanups: string[] = [];

function makeJobDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spend-test-"));
	cleanups.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of cleanups.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

interface FixtureDriver {
	createNoCostRun(dir: string): void;
	createMeasuredCostRun(dir: string, costs: number[], caches: number[]): number;
	createMixedCostRun(dir: string, measuredCost: number): void;
}

const FIXTURE_DRIVERS: Record<BenchmarkKind, FixtureDriver> = {
	harbor: {
		createNoCostRun(dir: string): void {
			const t1 = path.join(dir, "task1__0");
			const t2 = path.join(dir, "task2__0");
			fs.mkdirSync(t1, { recursive: true });
			fs.mkdirSync(t2, { recursive: true });
			fs.writeFileSync(
				path.join(t1, "result.json"),
				JSON.stringify({
					agent_result: { n_input_tokens: 100, n_output_tokens: 20 },
					verifier_result: { rewards: { reward: 1 } },
				}),
			);
			fs.writeFileSync(
				path.join(t2, "result.json"),
				JSON.stringify({
					agent_result: { n_input_tokens: 150, n_output_tokens: 30 },
					verifier_result: { rewards: { reward: 0 } },
				}),
			);
		},
		createMeasuredCostRun(dir: string, costs: number[], caches: number[]): number {
			let expectedSum = 0;
			for (let i = 0; i < costs.length; i++) {
				const trialDir = path.join(dir, `task${i}__0`);
				fs.mkdirSync(trialDir, { recursive: true });
				expectedSum += costs[i]!;
				fs.writeFileSync(
					path.join(trialDir, "result.json"),
					JSON.stringify({
						agent_result: {
							cost_usd: costs[i],
							n_input_tokens: 100,
							n_output_tokens: 20,
							n_cache_tokens: caches[i],
						},
						verifier_result: { rewards: { reward: 1 } },
					}),
				);
			}
			return expectedSum;
		},
		createMixedCostRun(dir: string, measuredCost: number): void {
			const t1 = path.join(dir, "task1__0");
			const t2 = path.join(dir, "task2__0");
			fs.mkdirSync(t1, { recursive: true });
			fs.mkdirSync(t2, { recursive: true });
			fs.writeFileSync(
				path.join(t1, "result.json"),
				JSON.stringify({
					agent_result: { cost_usd: measuredCost, n_input_tokens: 100, n_output_tokens: 20 },
					verifier_result: { rewards: { reward: 1 } },
				}),
			);
			fs.writeFileSync(
				path.join(t2, "result.json"),
				JSON.stringify({
					agent_result: { n_input_tokens: 150, n_output_tokens: 30 },
					verifier_result: { rewards: { reward: 0 } },
				}),
			);
		},
	},
	edit: {
		createNoCostRun(dir: string): void {
			fs.writeFileSync(
				path.join(dir, "result.json"),
				JSON.stringify({
					tasks: [
						{
							id: "task-a",
							name: "Task A",
							runs: [
								{
									runIndex: 0,
									success: true,
									duration: 1000,
									tokens: { input: 100, output: 20, reasoning: 0 },
								},
							],
						},
					],
					summary: {
						totalRuns: 1,
						successfulRuns: 1,
						taskSuccessRate: 1,
						editSuccessRate: 1,
						totalTokens: { input: 100, output: 20 },
					},
				}),
			);
		},
		createMeasuredCostRun(dir: string, costs: number[], caches: number[]): number {
			let expectedSum = 0;
			const runs = costs.map((cost, i) => {
				expectedSum += cost;
				return {
					runIndex: i,
					success: true,
					duration: 1000,
					costUsd: cost,
					tokens: { input: 100, output: 20, reasoning: 0, cache: caches[i] },
				};
			});
			fs.writeFileSync(
				path.join(dir, "result.json"),
				JSON.stringify({
					tasks: [{ id: "task-a", name: "Task A", runs }],
					summary: {
						totalRuns: runs.length,
						successfulRuns: runs.length,
						taskSuccessRate: 1,
						editSuccessRate: 1,
						totalTokens: { input: 100 * runs.length, output: 20 * runs.length },
					},
				}),
			);
			return expectedSum;
		},
		createMixedCostRun(dir: string, measuredCost: number): void {
			fs.writeFileSync(
				path.join(dir, "result.json"),
				JSON.stringify({
					tasks: [
						{
							id: "task-a",
							name: "Task A",
							runs: [
								{
									runIndex: 0,
									success: true,
									duration: 1000,
									costUsd: measuredCost,
									tokens: { input: 100, output: 20, reasoning: 0 },
								},
								{
									runIndex: 1,
									success: true,
									duration: 1000,
									tokens: { input: 100, output: 20, reasoning: 0 },
								},
							],
						},
					],
					summary: {
						totalRuns: 2,
						successfulRuns: 2,
						taskSuccessRate: 1,
						editSuccessRate: 1,
						totalTokens: { input: 200, output: 40 },
					},
				}),
			);
		},
	},
	deepswe: {
		createNoCostRun(dir: string): void {
			fs.writeFileSync(
				path.join(dir, "results.json"),
				JSON.stringify({
					model: "test-model",
					arms: ["arm1"],
					tasks: ["task1", "task2"],
					results: [
						{
							arm: "arm1",
							task: "task1",
							reward: 1,
							partial: null,
							inputTokens: 100,
							outputTokens: 20,
							cacheTokens: null,
							costUsd: null,
							agentSeconds: 10,
							toolCalls: null,
							error: null,
						},
						{
							arm: "arm1",
							task: "task2",
							reward: 0,
							partial: null,
							inputTokens: 150,
							outputTokens: 30,
							cacheTokens: null,
							costUsd: null,
							agentSeconds: 12,
							toolCalls: null,
							error: null,
						},
					],
				}),
			);
		},
		createMeasuredCostRun(dir: string, costs: number[], caches: number[]): number {
			let expectedSum = 0;
			const results = costs.map((cost, i) => {
				expectedSum += cost;
				return {
					arm: "arm1",
					task: `task${i}`,
					reward: 1,
					partial: null,
					inputTokens: 100,
					outputTokens: 20,
					cacheTokens: caches[i] ?? null,
					costUsd: cost,
					agentSeconds: 10,
					toolCalls: null,
					error: null,
				};
			});
			fs.writeFileSync(
				path.join(dir, "results.json"),
				JSON.stringify({
					model: "test-model",
					arms: ["arm1"],
					tasks: costs.map((_, i) => `task${i}`),
					results,
				}),
			);
			return expectedSum;
		},
		createMixedCostRun(dir: string, measuredCost: number): void {
			fs.writeFileSync(
				path.join(dir, "results.json"),
				JSON.stringify({
					model: "test-model",
					arms: ["arm1"],
					tasks: ["task1", "task2"],
					results: [
						{
							arm: "arm1",
							task: "task1",
							reward: 1,
							partial: null,
							inputTokens: 100,
							outputTokens: 20,
							cacheTokens: null,
							costUsd: measuredCost,
							agentSeconds: 10,
							toolCalls: null,
							error: null,
						},
						{
							arm: "arm1",
							task: "task2",
							reward: 0,
							partial: null,
							inputTokens: 150,
							outputTokens: 30,
							cacheTokens: null,
							costUsd: null,
							agentSeconds: 12,
							toolCalls: null,
							error: null,
						},
					],
				}),
			);
		},
	},
};

describe("unknown spend is never reported as zero across all benchmark adapters", () => {
	const kinds: BenchmarkKind[] = [...listBenchmarkKinds()];

	it.each(kinds)("reports null costUsd and tokCache when %s artifacts carry no cost", kind => {
		const driver = FIXTURE_DRIVERS[kind];
		expect(driver).toBeDefined();

		const dir = makeJobDir();
		driver.createNoCostRun(dir);

		const snapshot = readBenchmarkSnapshot(kind, dir);
		expect(snapshot.costUsd).toBeNull();
		expect(snapshot.tokCache).toBeNull();
		for (const trace of snapshot.traces) {
			expect(trace.costUsd).toBeNull();
		}
	});

	it.each(kinds)("reports exact sum when all %s trials carry measured costs and cache tokens", kind => {
		const driver = FIXTURE_DRIVERS[kind];
		expect(driver).toBeDefined();

		const dir = makeJobDir();
		const costs = [0.125, 0.375];
		const caches = [1200, 2400];
		const expectedSum = driver.createMeasuredCostRun(dir, costs, caches);

		const snapshot = readBenchmarkSnapshot(kind, dir);
		expect(snapshot.costUsd).toBeCloseTo(expectedSum, 5);
		expect(snapshot.tokCache).toBe(3600);
		const traceCosts = snapshot.traces.map(t => t.costUsd).sort();
		const expectedSorted = [...costs].sort();
		expect(traceCosts).toHaveLength(expectedSorted.length);
		for (let i = 0; i < expectedSorted.length; i++) {
			expect(traceCosts[i]).toBeCloseTo(expectedSorted[i]!, 5);
		}
	});

	it.each(kinds)("reports sum of measured only when %s has mixed measured and unmeasured trials", kind => {
		const driver = FIXTURE_DRIVERS[kind];
		expect(driver).toBeDefined();

		const dir = makeJobDir();
		driver.createMixedCostRun(dir, 0.42);

		const snapshot = readBenchmarkSnapshot(kind, dir);
		expect(snapshot.costUsd).toBeCloseTo(0.42, 5);
		const measuredTrace = snapshot.traces.find(t => t.costUsd !== null);
		const unmeasuredTrace = snapshot.traces.find(t => t.costUsd === null);
		expect(measuredTrace?.costUsd).toBeCloseTo(0.42, 5);
		expect(unmeasuredTrace?.costUsd).toBeNull();
	});

	it("fails if a new benchmark kind is added without fixture driver coverage", () => {
		for (const kind of kinds) {
			expect(FIXTURE_DRIVERS[kind]).toBeDefined();
		}
	});
});
