/**
 * WHY THIS SUITE EXISTS.
 *
 * A benchmark adapter registry existed, but four sites still decided by benchmark name instead of
 * reading the adapter: the launch endpoint picked the dataset and the runner argv from an
 * `if (benchmark === "deepswe") … else if (benchmark === "edit") … else harbor` ladder, resume
 * refused anything whose name was not `"harbor"`, the run store inferred a suite and a backend from
 * a dataset ladder holding the same three names, and the dashboard hardcoded the three benchmark
 * options and showed its resume control only for `"harbor"`. Registering a fourth benchmark
 * therefore produced a run that could not be launched, whose suite and backend were guessed as
 * harbor's, and which the dashboard never offered.
 *
 * The class this closes: a registry whose members are enumerated by name somewhere else, so adding
 * a member leaves the new one working nowhere and the old ones working by coincidence. Every case
 * here derives its expectations from the registry at run time, so a fourth adapter that fails to
 * declare its dataset, its argv or its resume support turns this suite red rather than failing at
 * launch.
 *
 * The launch case spawns a real child (`bun -e`, exiting immediately) through the real
 * `RunnerManager`, and reads back the argv the manager recorded in the run's own manager log, so it
 * proves what was spawned rather than that a function was called.
 *
 * What it does not catch: whether each builtin adapter's argv is the invocation its runner CLI
 * accepts today — the suites' own CLI tests own their flags — and the dashboard's rendering of the
 * benchmark list, which the web tests own.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleepFor } from "node:timers/promises";
import {
	type BenchmarkAdapter,
	type BenchmarkSnapshot,
	canonicalSuiteOf,
	DEFAULT_BENCHMARK_KIND,
	getBenchmark,
	listBenchmarkDefinitions,
	listBenchmarks,
	registerBenchmark,
	unregisterBenchmark,
} from "../../src/manager/benchmarks";
import { inferSuiteAndBackend, RunStore } from "../../src/manager/store";
import { evalsPackageDir } from "../../src/paths";
import { RunnerManager } from "../../src/server/runner";
import type { BenchmarkKind, LaunchRequest } from "../../src/wire";

const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) {
		cleanups.pop()?.();
	}
});

const EMPTY_SNAPSHOT: BenchmarkSnapshot = {
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

/** A benchmark nothing in `src` knows about, registered for the length of one case. */
function fourthBenchmark(overrides: Partial<BenchmarkAdapter> = {}): BenchmarkAdapter {
	return {
		kind: "fourth_bench" as BenchmarkKind,
		label: "Fourth bench",
		backend: "in-process",
		metrics: [{ key: "score", label: "Score", format: "percent", higherIsBetter: true }],
		defaultDataset: "fourth-corpus",
		suiteForDataset: dataset => (dataset === "fourth-corpus" ? "fourth-corpus@1.0" : undefined),
		launchArgv: ({ request, jobDir }) => ["bun", "-e", "process.exit(0)", request.model, jobDir],
		readSnapshot: () => EMPTY_SNAPSHOT,
		...overrides,
	};
}

function withBenchmark(adapter: BenchmarkAdapter): BenchmarkAdapter {
	registerBenchmark(adapter);
	cleanups.push(() => {
		unregisterBenchmark(adapter.kind);
	});
	return adapter;
}

interface Harness {
	readonly jobsDir: string;
	readonly store: RunStore;
	readonly manager: RunnerManager;
}

function harness(): Harness {
	const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "fourth-benchmark-test-"));
	const store = new RunStore(jobsDir);
	const manager = new RunnerManager(jobsDir, store, () => {});
	cleanups.push(() => {
		manager.stop();
		store.close();
		try {
			fs.rmSync(jobsDir, { recursive: true, force: true });
		} catch {}
	});
	return { jobsDir, store, manager };
}

/** The argv line the manager wrote when it spawned the run's child. */
function spawnedArgv(jobsDir: string, jobName: string): string {
	const log = fs.readFileSync(path.join(jobsDir, "_manager", "logs", `${jobName}.log`), "utf8");
	const header = log.split("\n").find(line => line.startsWith("==="));
	return header?.split(" ").slice(2).join(" ") ?? "";
}

describe("every registered benchmark states its own dataset, argv and resume support", () => {
	it("claims the suite of its own default dataset", () => {
		const adapters = listBenchmarks();
		expect(adapters.length).toBeGreaterThanOrEqual(3);

		for (const adapter of adapters) {
			// An adapter whose default dataset it does not itself claim would have every legacy run of
			// that dataset attributed to another benchmark.
			expect(adapter.defaultDataset).not.toBe("");
			expect(canonicalSuiteOf(adapter)).not.toBe("");
			expect(adapter.suiteForDataset(adapter.defaultDataset)).toBe(canonicalSuiteOf(adapter));
		}
	});

	it("builds a runner argv naming a script this package ships", () => {
		const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "fourth-benchmark-argv-"));
		cleanups.push(() => {
			fs.rmSync(jobsDir, { recursive: true, force: true });
		});
		const request: LaunchRequest = { model: "provider/model-id", tasks: 2, concurrency: 3 };

		for (const adapter of listBenchmarks()) {
			const argv = adapter.launchArgv({
				request,
				jobsDir,
				jobName: "argv-probe",
				jobDir: path.join(jobsDir, "argv-probe"),
				dataset: adapter.defaultDataset,
			});
			expect(argv[0]).toBe("bun");
			const script = argv[1] ?? "";
			expect(script.startsWith("src/")).toBe(true);
			// Run from the package directory, so the script path resolves there or the spawn dies
			// with "module not found" after the row is already recorded as running.
			expect(fs.existsSync(path.join(evalsPackageDir(), script))).toBe(true);
			expect(argv).toContain(request.model);
		}
	});

	it("reports resume support as the adapters declare it, and no wider", () => {
		const definitions = listBenchmarkDefinitions();
		const adapters = listBenchmarks();
		expect(definitions.length).toBe(adapters.length);

		for (const def of definitions) {
			const adapter = getBenchmark(def.kind);
			expect(adapter).toBeDefined();
			expect(def.defaultDataset).toBe(adapter?.defaultDataset ?? "");
			expect(def.resumable).toBe(adapter?.resumeArgv !== undefined);
		}
		// Pinned by equality: a benchmark that gains or loses in-place resume is a decision, and the
		// dashboard offers its resume control off exactly this set.
		expect(definitions.filter(d => d.resumable).map(d => d.kind)).toEqual(["harbor"]);
	});
});

describe("a benchmark registered at run time", () => {
	it("launches under the argv and dataset its adapter states", async () => {
		const adapter = withBenchmark(fourthBenchmark());
		const h = harness();

		const { jobName } = h.manager.launch({ model: "provider/model-id", benchmark: adapter.kind });

		const row = h.store.getRun(jobName);
		expect(row?.benchmark).toBe("fourth_bench");
		expect(row?.dataset).toBe("fourth-corpus");
		expect(row?.suite).toBe("fourth-corpus@1.0");
		expect(row?.backend).toBe("in-process");
		expect(spawnedArgv(h.jobsDir, jobName)).toBe(
			`bun -e process.exit(0) provider/model-id ${path.join(h.jobsDir, jobName)}`,
		);

		// The child exits immediately; the manager's exit handler writes the row's terminal state.
		// Awaiting the row rather than a duration keeps the case honest about what it observes.
		for (let waited = 0; waited < 50 && h.store.getRun(jobName)?.status === "running"; waited += 1) {
			await sleepFor(20);
		}
		expect(h.store.getRun(jobName)?.status).not.toBe("running");
	});

	it("is refused by name when it cannot resume, and resumes when it can", () => {
		const noResume = withBenchmark(fourthBenchmark());
		const h = harness();
		h.store.registerLaunch({
			benchmark: noResume.kind,
			jobName: "fourth-run",
			dataset: noResume.defaultDataset,
			agent: "veyyon",
			models: ["provider/model-id"],
			config: {},
			pid: 1,
		});
		h.store.markExit("fourth-run", 1);

		expect(() => h.manager.resume("fourth-run")).toThrow(/fourth_bench cannot resume a run in place/);

		unregisterBenchmark(noResume.kind);
		const resumable = withBenchmark(
			fourthBenchmark({
				resumeArgv: ctx => ["bun", "-e", "process.exit(0)", "--resume", ctx.jobName],
			}),
		);
		expect(resumable.resumeArgv).toBeDefined();

		const { jobName } = h.manager.resume("fourth-run");
		expect(jobName).toBe("fourth-run");
		expect(spawnedArgv(h.jobsDir, jobName)).toBe("bun -e process.exit(0) --resume fourth-run");
	});

	it("owns the suite and backend of the dataset it claims", () => {
		const adapter = withBenchmark(fourthBenchmark());

		expect(inferSuiteAndBackend({ dataset: "fourth-corpus" })).toEqual({
			suite: "fourth-corpus@1.0",
			backend: "in-process",
			benchmark: adapter.kind,
		});
		// Its own name with a dataset it does not claim still resolves to its canonical suite.
		expect(inferSuiteAndBackend({ benchmark: adapter.kind, dataset: "unclaimed" })).toEqual({
			suite: "fourth-corpus@1.0",
			backend: "in-process",
			benchmark: adapter.kind,
		});
	});
});

describe("a settled run whose runner process is gone", () => {
	const FINISHED_AT = Date.parse("2026-02-01T10:00:00.000Z");

	/**
	 * A row whose runner is gone with no exit recorded, and the job directory it left behind. The
	 * store releases a dead pid in `syncActive`, which is the state the terminal-state read serves.
	 */
	function abandonedRun(h: Harness, jobName: string, benchmark: string, jobResult: object): void {
		const jobDir = path.join(h.jobsDir, jobName);
		fs.mkdirSync(jobDir, { recursive: true });
		fs.writeFileSync(path.join(jobDir, "result.json"), JSON.stringify(jobResult));
		h.store.registerLaunch({
			benchmark,
			jobName,
			dataset: "terminal-bench@2.0",
			agent: "veyyon",
			models: ["provider/model-id"],
			config: {},
			pid: 999999999, // certainly dead
		});
		h.store.syncActive();
	}

	it("takes its finish time from the benchmark that can read one", () => {
		const h = harness();
		abandonedRun(h, "harbor-abandoned", "harbor", {
			n_total_trials: 2,
			finished_at: "2026-02-01T10:00:00.000Z",
		});

		const row = h.store.getRun("harbor-abandoned");
		expect(row?.pid).toBeNull();
		expect(row?.status).toBe("complete");
		expect(row?.finishedAt).toBe(FINISHED_AT);
	});

	it("falls back to the job directory for a benchmark that reads none", () => {
		const adapter = withBenchmark(fourthBenchmark());
		const h = harness();
		// The same artifact the harbor adapter reads: this benchmark declares no reader, so the
		// timestamp inside it must not become this run's finish time.
		abandonedRun(h, "fourth-abandoned", adapter.kind, {
			n_total_trials: 2,
			finished_at: "2026-02-01T10:00:00.000Z",
		});

		const row = h.store.getRun("fourth-abandoned");
		expect(row?.pid).toBeNull();
		expect(row?.finishedAt).not.toBe(FINISHED_AT);
		expect(row?.status).toBe("running");
	});
});

describe("a run record with no suite of its own", () => {
	const TABLE = [
		["terminal-bench@3.0", "terminal-bench@3.0", "harbor", "harbor"],
		["terminal-bench-3", "terminal-bench@3.0", "harbor", "harbor"],
		["terminal-bench-2", "terminal-bench@2.0", "harbor", "harbor"],
		["terminal-bench@2.0", "terminal-bench@2.0", "harbor", "harbor"],
		["deep-swe", "deep-swe", "pier", "deepswe"],
		["typescript-edit", "typescript-edit", "in-process", "edit"],
		["some-corpus-nothing-claims", "some-corpus-nothing-claims", "harbor", "harbor"],
		["", "terminal-bench@2.0", "harbor", "harbor"],
	] as [string, string, string, string][];

	it.each(TABLE)("reads %p as suite %p on backend %p", (dataset, suite, backend, benchmark) => {
		expect(inferSuiteAndBackend({ dataset })).toEqual({ suite, backend, benchmark });
	});

	it("keeps a suite and backend it already recorded, whatever its dataset says", () => {
		expect(inferSuiteAndBackend({ suite: "custom@9", backend: "pier", dataset: "deep-swe" })).toEqual({
			suite: "custom@9",
			backend: "pier",
			benchmark: "deepswe",
		});
	});

	it("resolves an unregistered benchmark through the default adapter without renaming it", () => {
		const inferred = inferSuiteAndBackend({ benchmark: "gone_bench", dataset: "left-behind" });
		expect(inferred.benchmark).toBe("gone_bench");
		expect(inferred.suite).toBe("left-behind");
		expect(inferred.backend).toBe(getBenchmark(DEFAULT_BENCHMARK_KIND)?.backend ?? "");
	});
});
