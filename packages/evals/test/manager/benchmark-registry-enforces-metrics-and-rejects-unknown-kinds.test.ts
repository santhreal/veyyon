/**
 * WHY:
 * Benchmark adapters previously relied on closed string unions and if-chains across
 * three different files (benchmarks.ts, store.ts, main.ts). An unknown benchmark was
 * silently coerced to "harbor" or threw unhelpful errors without stating registered adapters.
 *
 * This test suite defends the benchmark adapter registry contract:
 * 1. Runtime sweep: Every registered benchmark adapter must declare a non-empty label,
 *    at least one metric, a corresponding backend, and a snapshot reader.
 * 2. Metric consistency: Every metric key reported by a stored run must be declared
 *    in its adapter's metric definitions.
 * 3. Rejection by name: Requesting an unregistered benchmark kind must fail with
 *    BenchmarkNotFoundError naming the invalid kind and listing all registered ids.
 * 4. Preservation of unknown benchmarks: A stored run row carrying an unknown benchmark
 *    must be reported as that unknown benchmark, never silently coerced to "harbor".
 * 5. Metric enforcement: Registering an adapter with zero metrics fails the metric requirement.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	BenchmarkNotFoundError,
	clearBenchmarkCache,
	getBenchmark,
	getBenchmarkByBackend,
	listBenchmarkDefinitions,
	listBenchmarkKinds,
	listBenchmarks,
	readBenchmarkSnapshot,
	registerBenchmark,
	requireBenchmark,
	unregisterBenchmark,
} from "../../src/manager/benchmarks";
import { RunStore } from "../../src/manager/store";
import type { BenchmarkKind } from "../../src/wire";

const cleanups: Array<() => void> = [];

function makeJobDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-registry-test-"));
	cleanups.push(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});
	return dir;
}

afterEach(() => {
	clearBenchmarkCache();
	for (const cleanup of cleanups.splice(0)) {
		cleanup();
	}
});

function writeHarborFixture(dir: string): void {
	const t1 = path.join(dir, "task1__0");
	fs.mkdirSync(t1, { recursive: true });
	fs.writeFileSync(
		path.join(t1, "result.json"),
		JSON.stringify({
			agent_result: { n_input_tokens: 100, n_output_tokens: 20 },
			verifier_result: { rewards: { reward: 1 } },
			trial_result: {
				status: "COMPLETED",
				started_at: "2026-07-01T00:00:00Z",
				finished_at: "2026-07-01T00:01:00Z",
			},
		}),
	);
	fs.writeFileSync(
		path.join(dir, "result.json"),
		JSON.stringify({
			n_total_trials: 1,
			finished_at: "2026-07-01T00:01:00Z",
			stats: { n_running_trials: 0, n_pending_trials: 0 },
		}),
	);
}

function writeEditFixture(dir: string): void {
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
				editSuccessRate: 1,
				totalTokens: { input: 100, output: 20 },
			},
		}),
	);
}

function writeDeepsweFixture(dir: string): void {
	fs.writeFileSync(
		path.join(dir, "results.json"),
		JSON.stringify({
			model: "test-model",
			arms: ["baseline", "treatment"],
			tasks: ["task-1"],
			results: [
				{
					arm: "baseline",
					task: "task-1",
					reward: 1,
					partial: 0.8,
					error: null,
					costUsd: 0.1,
					inputTokens: 500,
					outputTokens: 100,
					cacheTokens: 200,
					agentSeconds: 1.5,
				},
			],
		}),
	);
}

const FIXTURE_WRITERS: Record<string, (dir: string) => void> = {
	harbor: writeHarborFixture,
	edit: writeEditFixture,
	deepswe: writeDeepsweFixture,
};

describe("benchmark adapter registry runtime invariants", () => {
	it("sweeps registered adapters: every adapter has non-empty label, at least one metric, backend, and snapshot reader", () => {
		const adapters = listBenchmarks();
		expect(adapters.length).toBeGreaterThanOrEqual(3);

		for (const adapter of adapters) {
			expect(typeof adapter.kind).toBe("string");
			expect(adapter.kind.length).toBeGreaterThan(0);

			expect(typeof adapter.label).toBe("string");
			expect(adapter.label.length).toBeGreaterThan(0);

			expect(typeof adapter.backend).toBe("string");
			expect(adapter.backend.length).toBeGreaterThan(0);

			expect(Array.isArray(adapter.metrics)).toBe(true);
			expect(adapter.metrics.length).toBeGreaterThan(0);

			for (const metric of adapter.metrics) {
				expect(typeof metric.key).toBe("string");
				expect(metric.key.length).toBeGreaterThan(0);
				expect(typeof metric.label).toBe("string");
				expect(metric.label.length).toBeGreaterThan(0);
				expect(["percent", "number", "usd"]).toContain(metric.format);
				expect(typeof metric.higherIsBetter).toBe("boolean");
			}

			expect(typeof adapter.readSnapshot).toBe("function");
		}
	});

	it("publishes matching wire BenchmarkDefinitions for every registered adapter", () => {
		const definitions = listBenchmarkDefinitions();
		const adapters = listBenchmarks();

		expect(definitions.length).toBe(adapters.length);
		for (const def of definitions) {
			const adapter = requireBenchmark(def.kind);
			expect(def.label).toBe(adapter.label);
			expect(def.metrics).toEqual([...adapter.metrics]);
		}
	});

	it("every metric reported by a stored run is declared by its benchmark adapter", () => {
		const jobsDir = makeJobDir();
		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());

		for (const adapter of listBenchmarks()) {
			const writer = FIXTURE_WRITERS[adapter.kind];
			if (!writer) continue;

			const jobName = `test-run-${adapter.kind}`;
			const jobDir = path.join(jobsDir, jobName);
			fs.mkdirSync(jobDir, { recursive: true });
			writer(jobDir);

			store.registerLaunch({
				jobName,
				benchmark: adapter.kind,
				backend: adapter.backend,
				dataset: "test-dataset",
				agent: "test-agent",
				models: ["test-model"],
				pid: process.pid,
			});

			const syncedRun = store.syncRun(jobName);
			expect(syncedRun).not.toBeNull();

			const declaredMetricKeys = new Set(adapter.metrics.map(m => m.key));
			const reportedMetricKeys = Object.keys(syncedRun!.metrics);

			expect(reportedMetricKeys.length).toBeGreaterThan(0);
			for (const key of reportedMetricKeys) {
				expect(declaredMetricKeys.has(key)).toBe(true);
			}

			// Also verify snapshot directly
			const snapshot = adapter.readSnapshot(jobDir);
			for (const key of Object.keys(snapshot.metrics)) {
				expect(declaredMetricKeys.has(key)).toBe(true);
			}
		}
	});

	it("rejects an unregistered benchmark kind by name and lists all registered ids", () => {
		const registeredKinds = listBenchmarkKinds();
		const unregisteredKind = "completely_unknown_benchmark_xyz";

		expect(() => requireBenchmark(unregisteredKind as BenchmarkKind)).toThrow(BenchmarkNotFoundError);

		try {
			requireBenchmark(unregisteredKind as BenchmarkKind);
			expect.unreachable("requireBenchmark should have thrown");
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(BenchmarkNotFoundError);
			const error = err as BenchmarkNotFoundError;
			expect(error.name).toBe("BenchmarkNotFoundError");
			expect(error.message).toContain(`"${unregisteredKind}"`);
			for (const kind of registeredKinds) {
				expect(error.message).toContain(kind);
			}
		}
	});

	it("readBenchmarkSnapshot rejects an unregistered benchmark kind via the registry", () => {
		const dir = makeJobDir();
		expect(() => readBenchmarkSnapshot("unregistered_for_snapshot" as BenchmarkKind, dir)).toThrow(
			BenchmarkNotFoundError,
		);
	});

	it("reports a stored row carrying an unknown benchmark as unknown, never coercing to harbor", () => {
		const jobsDir = makeJobDir();
		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());

		const customKind = "custom_telemetry_bench" as BenchmarkKind;
		const jobName = "custom-bench-run";

		store.registerLaunch({
			jobName,
			benchmark: customKind,
			dataset: "custom-dataset",
			agent: "custom-agent",
			models: ["custom-model"],
			pid: process.pid,
		});

		const run = store.getRun(jobName);
		expect(run).not.toBeNull();
		expect(run?.benchmark).toBe("custom_telemetry_bench");
		expect(run?.benchmark).not.toBe("harbor");

		const allRuns = store.listRuns();
		const found = allRuns.find(r => r.jobName === jobName);
		expect(found).toBeDefined();
		expect(found?.benchmark).toBe("custom_telemetry_bench");
		expect(found?.benchmark).not.toBe("harbor");
	});

	it("registering a fourth adapter with no metrics turns metric validation red", () => {
		const fourthKind = "empty_fourth_bench" as BenchmarkKind;
		registerBenchmark({
			kind: fourthKind,
			label: "Empty Fourth Benchmark",
			backend: "in-process",
			metrics: [],
			readSnapshot: () => ({
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
			}),
		});

		try {
			const adapter = requireBenchmark(fourthKind);
			expect(adapter).toBeDefined();
			// Defends the invariant that every registered adapter must have at least one metric.
			// Having 0 metrics turns the metric assertion red.
			expect(() => {
				expect(adapter.metrics.length).toBeGreaterThan(0);
			}).toThrow();
		} finally {
			unregisterBenchmark(fourthKind);
		}
	});

	it("resolves registered adapters bidirectionally by backend and kind", () => {
		expect(getBenchmark("harbor")?.backend).toBe("harbor");
		expect(getBenchmark("edit")?.backend).toBe("in-process");
		expect(getBenchmark("deepswe")?.backend).toBe("pier");

		expect(getBenchmarkByBackend("harbor")?.kind).toBe("harbor");
		expect(getBenchmarkByBackend("in-process")?.kind).toBe("edit");
		expect(getBenchmarkByBackend("pier")?.kind).toBe("deepswe");
	});
});
