/**
 * WHY: the run store declared `cost_usd` and `tok_cache` `NOT NULL DEFAULT 0`, so a run nobody
 * priced was stored as $0 and read back as free work. Rows also carried no experiment identity,
 * and grouping recovered one by slicing the job name at its first dash — which read
 * `deep-swe-baseline` as arm `swe-baseline` of an experiment called `deep`, colliding every
 * unrelated `deep-*` run into one experiment.
 *
 * The class closed here is "the store answers a question it has no data for": an absent
 * measurement must survive as absent, and identity must be recorded rather than parsed back out
 * of a name. Both need a schema change, so the suite also drives the migration from the old
 * declaration, which is the part that only breaks on somebody's existing database.
 *
 * What it does not catch: whether a backend measures spend at all, and the arithmetic over these
 * values (that is core/scoring.ts and its own suite).
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { experimentOf, knownExperimentIds } from "../../store/experiments";
import { CURRENT_SCHEMA_VERSION, RunStore, UnreadableSchemaError } from "../../store/sqlite";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function makeJobsDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-store-spend-"));
	cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function openStore(jobsDir: string, dbPath: string): RunStore {
	const store = new RunStore(jobsDir, dbPath);
	cleanups.push(() => store.close());
	return store;
}

/**
 * A harbor job dir with one finished trial. `agentResult` is that trial's `agent_result`, so a
 * caller decides whether spend was measured at all, which is the whole question here.
 */
function writeHarborJob(jobsDir: string, jobName: string, agentResult: Record<string, unknown>): void {
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
			agent_result: agentResult,
		}),
	);
}

describe("spend the store never measured", () => {
	it("keeps an unmeasured cost absent, and a measured zero at zero", () => {
		const jobsDir = makeJobsDir();
		writeHarborJob(jobsDir, "unmeasured", { n_input_tokens: 100, n_output_tokens: 10 });
		writeHarborJob(jobsDir, "free", { cost_usd: 0, n_input_tokens: 100, n_output_tokens: 10, n_cache_tokens: 0 });
		const store = openStore(jobsDir, path.join(jobsDir, "evals.sqlite"));
		store.discover();
		store.syncAll();

		const unmeasured = store.getRun("unmeasured");
		expect(unmeasured?.costUsd).toBeNull();
		expect(unmeasured?.tokCache).toBeNull();
		expect(store.listTraces("unmeasured").map(t => t.costUsd)).toEqual([null]);

		const free = store.getRun("free");
		expect(free?.costUsd).toBe(0);
		expect(free?.tokCache).toBe(0);
		expect(store.listTraces("free").map(t => t.costUsd)).toEqual([0]);
	});

	it("migrates a database whose spend columns still refuse NULL, keeping the recorded values", () => {
		const jobsDir = makeJobsDir();
		fs.mkdirSync(path.join(jobsDir, "_manager"), { recursive: true });
		const dbPath = path.join(jobsDir, "legacy.sqlite");

		// The declaration that shipped before this change, with one row already in it.
		const legacy = new Database(dbPath);
		legacy.run(`CREATE TABLE runs (
			job_name TEXT PRIMARY KEY,
			schema_version INTEGER NOT NULL DEFAULT 2,
			suite TEXT NOT NULL DEFAULT '',
			backend TEXT NOT NULL DEFAULT 'harbor',
			benchmark TEXT NOT NULL DEFAULT 'harbor',
			dataset TEXT NOT NULL DEFAULT '',
			agent TEXT NOT NULL DEFAULT 'veyyon',
			models TEXT NOT NULL DEFAULT '',
			prewalk TEXT,
			role TEXT NOT NULL DEFAULT '',
			note TEXT NOT NULL DEFAULT '',
			label TEXT NOT NULL DEFAULT '',
			config_json TEXT NOT NULL DEFAULT '{}',
			status TEXT NOT NULL DEFAULT 'running',
			pid INTEGER,
			exit_code INTEGER,
			created_at INTEGER NOT NULL,
			finished_at INTEGER,
			n_total INTEGER NOT NULL DEFAULT 0,
			done INTEGER NOT NULL DEFAULT 0,
			pass INTEGER NOT NULL DEFAULT 0,
			fail INTEGER NOT NULL DEFAULT 0,
			error INTEGER NOT NULL DEFAULT 0,
			running INTEGER NOT NULL DEFAULT 0,
			cost_usd REAL NOT NULL DEFAULT 0,
			tok_in INTEGER NOT NULL DEFAULT 0,
			tok_out INTEGER NOT NULL DEFAULT 0,
			score REAL,
			metrics_json TEXT NOT NULL DEFAULT '{}',
			tok_cache INTEGER NOT NULL DEFAULT 0
		)`);
		legacy.run(
			`INSERT INTO runs (job_name, schema_version, dataset, agent, models, status, created_at, n_total, done, pass, cost_usd, tok_cache)
			 VALUES ('old-run', 2, 'test-dataset@1.0', 'veyyon', 'm/x', 'complete', 1, 4, 4, 3, 1.25, 4096)`,
		);
		legacy.close();

		writeHarborJob(jobsDir, "new-run", { n_input_tokens: 5, n_output_tokens: 5 });
		const store = openStore(jobsDir, dbPath);

		// The pre-existing row transfers verbatim: nothing in it distinguishes an unmeasured
		// cost from a measured one, so the migration invents no NULLs.
		const migrated = store.getRun("old-run");
		expect(migrated?.costUsd).toBeCloseTo(1.25, 10);
		expect(migrated?.tokCache).toBe(4096);

		// And the column now accepts the absence a fresh run has to record.
		store.discover();
		store.syncAll();
		expect(store.getRun("new-run")?.costUsd).toBeNull();

		// The rebuild is idempotent: a second open neither re-runs it nor loses a row.
		const reopened = openStore(jobsDir, dbPath);
		expect(
			reopened
				.listRuns()
				.map(r => r.jobName)
				.sort(),
		).toEqual(["new-run", "old-run"]);
	});
});

describe("experiment identity the store recorded", () => {
	it("keeps the experiment and arm a launch stated, instead of parsing them out of the job name", () => {
		const jobsDir = makeJobsDir();
		const store = openStore(jobsDir, path.join(jobsDir, "evals.sqlite"));
		store.registerLaunch({
			benchmark: "deepswe",
			jobName: "deep-swe-baseline",
			dataset: "deep-swe",
			agent: "veyyon",
			models: ["m/x"],
			pid: process.pid,
			experiment: "deep-swe",
			arm: "baseline",
		});

		const run = store.getRun("deep-swe-baseline");
		expect([run?.experiment, run?.arm]).toEqual(["deep-swe", "baseline"]);
		expect(experimentOf(run ?? { jobName: "deep-swe-baseline" })).toBe("deep-swe");
	});

	it("leaves an uncoordinated run as its own experiment rather than slicing its name", () => {
		const jobsDir = makeJobsDir();
		const store = openStore(jobsDir, path.join(jobsDir, "evals.sqlite"));
		store.registerLaunch({
			benchmark: "deepswe",
			jobName: "deep-swe-2026-01-01",
			dataset: "deep-swe",
			agent: "veyyon",
			models: ["m/x"],
			pid: process.pid,
		});

		const run = store.getRun("deep-swe-2026-01-01");
		expect([run?.experiment, run?.arm]).toEqual(["", ""]);
		// No registered id matches, so nothing is split off: the run stays its own single-arm
		// experiment instead of joining a fabricated experiment called "deep".
		expect(experimentOf(run ?? { jobName: "x" }, knownExperimentIds(store))).toBe("deep-swe-2026-01-01");
	});

	it("recovers grouping for a pre-coordinate run whose experiment id was registered", () => {
		const jobsDir = makeJobsDir();
		const store = openStore(jobsDir, path.join(jobsDir, "evals.sqlite"));
		store.setExperimentGoal("sb", "does the treatment beat the baseline?");
		for (const jobName of ["sb-base", "sb-treat"]) {
			store.registerLaunch({
				benchmark: "harbor",
				jobName,
				dataset: "terminal-bench@2.0",
				agent: "veyyon",
				models: ["m/x"],
				pid: process.pid,
			});
		}

		const ids = knownExperimentIds(store);
		expect(store.listRuns().map(r => experimentOf(r, ids))).toEqual(["sb", "sb"]);
	});

	it("prefers the longest registered id, so a nested experiment keeps its own arms", () => {
		const jobsDir = makeJobsDir();
		const store = openStore(jobsDir, path.join(jobsDir, "evals.sqlite"));
		store.setExperimentGoal("sb", "outer");
		store.setExperimentGoal("sb-v2", "inner");
		store.registerLaunch({
			benchmark: "harbor",
			jobName: "sb-v2-base",
			dataset: "terminal-bench@2.0",
			agent: "veyyon",
			models: ["m/x"],
			pid: process.pid,
		});

		const run = store.getRun("sb-v2-base");
		expect(experimentOf(run ?? { jobName: "x" }, knownExperimentIds(store))).toBe("sb-v2");
	});
});

describe("a row this build can no longer read", () => {
	it("omits it from the listing and refuses it by name", () => {
		const jobsDir = makeJobsDir();
		const dbPath = path.join(jobsDir, "evals.sqlite");
		const store = openStore(jobsDir, dbPath);
		store.registerLaunch({
			benchmark: "harbor",
			jobName: "ancient",
			dataset: "terminal-bench@2.0",
			agent: "veyyon",
			models: ["m/x"],
			pid: process.pid,
		});
		// Stamp the row with a schema this build does not read. An older stamp is migrated when a store
		// opens; a newer one cannot be, and this one appears under a store already open.
		const db = new Database(dbPath);
		db.run("UPDATE runs SET schema_version = ? WHERE job_name = 'ancient'", [CURRENT_SCHEMA_VERSION + 1]);
		db.close();

		expect(store.listRuns().map(r => r.jobName)).toEqual([]);
		expect(() => store.getRun("ancient")).toThrow(UnreadableSchemaError);
	});
});
