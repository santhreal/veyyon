/**
 * WHY THIS SUITE EXISTS.
 *
 * The run store stamped every row with a schema version and refused any row below the current one:
 * `listRuns` omitted it with a log line and `getRun` threw. Nothing upgraded such a row, so a jobs
 * directory carrying rows from an earlier build served a dashboard missing its own history, with a
 * refusal for anyone who asked for one of those runs by name, and no path forward but deleting the
 * database. The refusal also pointed the wrong way: a row a NEWER build wrote passed both readers
 * and was interpreted through this build's assumptions.
 *
 * A version-1 row predates the `suite`, `backend` and `benchmark` columns, so those columns hold
 * this table's `ALTER TABLE` defaults rather than anything that build recorded. Its dataset is what
 * it stated, and the benchmark registry reads a suite and a backend off a dataset, which is what the
 * migration does when the store opens.
 *
 * The class this closes: a persisted shape whose version gate has one direction and no migration, so
 * every old copy is lost and every newer copy is misread. Both directions are asserted here, and the
 * stale copy is asserted as SERVED with the right suite and backend rather than merely present.
 *
 * What it does not catch: a future schema 3 whose migration from 2 needs more than the dataset —
 * that migration lands with its own case — and the column-relaxing rebuild, which the store's
 * transaction suite owns.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CURRENT_SCHEMA_VERSION, RunStore, UnreadableSchemaError } from "../../store/sqlite";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

function makeTempJobsDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-version-test-"));
	cleanups.push(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});
	return dir;
}

/** A row written straight into the database under `version`, bypassing the store's own writer. */
function injectRow(jobsDir: string, jobName: string, version: number, dataset: string): void {
	const rawDb = new Database(path.join(jobsDir, "_manager", "evals.sqlite"));
	rawDb.run(
		`INSERT INTO runs (job_name, schema_version, dataset, agent, models, status, created_at)
		 VALUES (?, ?, ?, 'veyyon', 'legacy-model', 'complete', 1000000)`,
		[jobName, version, dataset],
	);
	rawDb.close();
}

/** A store opened once so its schema exists, then closed, leaving the database for injection. */
function seededJobsDir(): string {
	const jobsDir = makeTempJobsDir();
	const store = new RunStore(jobsDir);
	store.close();
	return jobsDir;
}

describe("a run record a newer build wrote", () => {
	it("is refused by name, naming both versions", () => {
		const jobsDir = seededJobsDir();
		injectRow(jobsDir, "from-the-future", CURRENT_SCHEMA_VERSION + 1, "terminal-bench@3.0");

		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());

		expect(() => store.getRun("from-the-future")).toThrow(UnreadableSchemaError);
		expect(() => store.getRun("from-the-future")).toThrow(
			new RegExp(`schema version ${CURRENT_SCHEMA_VERSION + 1} was written by a newer build`),
		);
		expect(() => store.getRun("from-the-future")).toThrow(new RegExp(`reads ${CURRENT_SCHEMA_VERSION}`));
	});

	it("is left out of a listing that still serves every readable row", () => {
		const jobsDir = seededJobsDir();
		injectRow(jobsDir, "from-the-future", CURRENT_SCHEMA_VERSION + 1, "terminal-bench@3.0");

		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());
		store.registerLaunch({
			jobName: "readable-job",
			dataset: "terminal-bench@3.0",
			agent: "veyyon",
			models: ["anthropic/claude-sonnet-4-6"],
			pid: 5678,
		});

		expect(store.listRuns().map(r => r.jobName)).toEqual(["readable-job"]);
	});
});

describe("a run record an older build wrote", () => {
	it("is migrated when the store opens, and served with the suite and backend its dataset names", () => {
		const jobsDir = seededJobsDir();
		injectRow(jobsDir, "legacy-harbor", 1, "terminal-bench@3.0");
		injectRow(jobsDir, "legacy-deepswe", 1, "deep-swe");
		injectRow(jobsDir, "legacy-edit", 1, "typescript-edit");

		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());

		const served = new Map(store.listRuns().map(row => [row.jobName, row]));
		expect([...served.keys()].sort()).toEqual(["legacy-deepswe", "legacy-edit", "legacy-harbor"]);
		expect(served.get("legacy-harbor")?.suite).toBe("terminal-bench@3.0");
		expect(served.get("legacy-harbor")?.backend).toBe("harbor");
		// The ALTER TABLE default for `backend` is harbor, so a migration that trusted the column
		// instead of the dataset would report these two on harbor as well.
		expect(served.get("legacy-deepswe")?.backend).toBe("pier");
		expect(served.get("legacy-deepswe")?.benchmark).toBe("deepswe");
		expect(served.get("legacy-edit")?.backend).toBe("in-process");
		expect(served.get("legacy-edit")?.benchmark).toBe("edit");
		for (const row of served.values()) {
			expect(row.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		}
	});

	it("is answered by name instead of refused", () => {
		const jobsDir = seededJobsDir();
		injectRow(jobsDir, "legacy-job", 1, "deep-swe");

		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());

		const row = store.getRun("legacy-job");
		expect(row?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		expect(row?.suite).toBe("deep-swe");
	});

	it("carries its migrated version on disk, so a second open migrates nothing", () => {
		const jobsDir = seededJobsDir();
		injectRow(jobsDir, "legacy-job", 1, "deep-swe");

		const first = new RunStore(jobsDir);
		first.close();

		const rawDb = new Database(path.join(jobsDir, "_manager", "evals.sqlite"));
		const stored = rawDb.query("SELECT schema_version, suite, backend FROM runs WHERE job_name = 'legacy-job'").get();
		rawDb.close();
		expect(stored).toEqual({ schema_version: CURRENT_SCHEMA_VERSION, suite: "deep-swe", backend: "pier" });
	});
});

describe("a run this build registers", () => {
	it("is stamped with the current schema and its own suite", () => {
		const jobsDir = makeTempJobsDir();
		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());

		for (const [jobName, dataset] of [
			["tb3-run", "terminal-bench@3.0"],
			["tb2-run", "terminal-bench@2.0"],
		]) {
			store.registerLaunch({
				jobName,
				dataset,
				agent: "veyyon",
				models: ["anthropic/claude-sonnet-4-6"],
				pid: 1234,
			});
			const row = store.getRun(jobName);
			expect(row?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
			expect(row?.suite).toBe(dataset);
			expect(row?.backend).toBe("harbor");
		}
	});
});
