import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CURRENT_SCHEMA_VERSION, RunStore, StaleSchemaError } from "../../src/manager/store";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

function makeTempJobsDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-version-test-"));
	cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/**
 * Defends the persisted store schema versioning invariant (AGENTS.md rule 7):
 * Changing a persisted shape requires a schema version bump plus a test that
 * stale copies are rejected rather than served.
 */
describe("RunStore persisted schema versioning and suite/backend identity", () => {
	it("stamps newly registered runs with CURRENT_SCHEMA_VERSION and suite/backend identity", () => {
		const jobsDir = makeTempJobsDir();
		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());

		store.registerLaunch({
			jobName: "tb3-run",
			dataset: "terminal-bench@3.0",
			agent: "veyyon",
			models: ["anthropic/claude-sonnet-4-6"],
			pid: 1234,
		});

		store.registerLaunch({
			jobName: "tb2-run",
			dataset: "terminal-bench@2.0",
			agent: "veyyon",
			models: ["anthropic/claude-sonnet-4-6"],
			pid: 1235,
		});

		const tb3 = store.getRun("tb3-run");
		expect(tb3).not.toBeNull();
		expect(tb3?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		expect(tb3?.suite).toBe("terminal-bench@3.0");
		expect(tb3?.backend).toBe("harbor");

		const tb2 = store.getRun("tb2-run");
		expect(tb2).not.toBeNull();
		expect(tb2?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		expect(tb2?.suite).toBe("terminal-bench@2.0");
		expect(tb2?.backend).toBe("harbor");

		// Proves that Terminal-Bench 3.0 and Terminal-Bench 2.0 runs are distinguishable rows
		expect(tb3?.suite).not.toBe(tb2?.suite);
	});

	it("rejects a stale row (schema_version < CURRENT_SCHEMA_VERSION) when retrieved via getRun", () => {
		const jobsDir = makeTempJobsDir();
		const dbPath = path.join(jobsDir, "_manager", "evals.sqlite");
		fs.mkdirSync(path.join(jobsDir, "_manager"), { recursive: true });

		// Seed a database with a legacy/stale row having schema_version = 1
		const rawDb = new Database(dbPath);
		rawDb.run(`
			CREATE TABLE runs (
				job_name TEXT PRIMARY KEY,
				schema_version INTEGER NOT NULL DEFAULT 1,
				suite TEXT NOT NULL DEFAULT '',
				backend TEXT NOT NULL DEFAULT 'harbor',
				benchmark TEXT NOT NULL DEFAULT 'harbor',
				dataset TEXT NOT NULL DEFAULT 'legacy-set',
				agent TEXT NOT NULL DEFAULT 'veyyon',
				models TEXT NOT NULL DEFAULT 'legacy-model',
				prewalk TEXT,
				role TEXT NOT NULL DEFAULT '',
				note TEXT NOT NULL DEFAULT '',
				label TEXT NOT NULL DEFAULT '',
				config_json TEXT NOT NULL DEFAULT '{}',
				status TEXT NOT NULL DEFAULT 'complete',
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
			);
		`);
		rawDb.run(`
			INSERT INTO runs (job_name, schema_version, dataset, agent, models, status, created_at)
			VALUES ('stale-job', 1, 'legacy-set', 'veyyon', 'legacy-model', 'complete', 1000000);
		`);
		rawDb.close();

		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());

		// Retrieving the stale record must throw StaleSchemaError rather than serving obsolete data
		expect(() => store.getRun("stale-job")).toThrow(StaleSchemaError);
		expect(() => store.getRun("stale-job")).toThrow(/schema version 1 is obsolete/);
	});

	it("omits stale rows from listRuns so they are never served in listings", () => {
		const jobsDir = makeTempJobsDir();
		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());

		// Add a current valid run
		store.registerLaunch({
			jobName: "valid-job",
			dataset: "terminal-bench@3.0",
			agent: "veyyon",
			models: ["anthropic/claude-sonnet-4-6"],
			pid: 5678,
		});

		// Directly inject a stale row with schema_version = 1 into the underlying sqlite db
		const dbPath = path.join(jobsDir, "_manager", "evals.sqlite");
		const rawDb = new Database(dbPath);
		rawDb.run(`
			INSERT INTO runs (job_name, schema_version, dataset, agent, models, status, created_at)
			VALUES ('stale-in-list', 1, 'legacy-set', 'veyyon', 'legacy-model', 'complete', 999999);
		`);
		rawDb.close();

		const runs = store.listRuns();
		expect(runs.map(r => r.jobName)).toEqual(["valid-job"]);
		expect(runs.find(r => r.jobName === "stale-in-list")).toBeUndefined();
	});
});
