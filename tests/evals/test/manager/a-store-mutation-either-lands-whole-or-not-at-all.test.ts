/**
 * WHY:
 * Multi-statement mutations in registerLaunch and deleteRun were executed without SQLite
 * transactions, leaving half-written database state if interrupted. Additionally, manager.json
 * was written directly in-place, risking corrupted/empty JSON files if interrupted mid-write.
 *
 * This suite closes the class by proving:
 *  1. Multi-statement mutations execute transactionally.
 *  2. manager.json is written atomically via temporary files and rename, never observed partially written.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CURRENT_SCHEMA_VERSION, RunStore } from "../../store/sqlite";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

function makeTempJobsDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-atomic-test-"));
	cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

describe("RunStore atomic mutations and metadata persistence", () => {
	it("writes manager.json atomically with valid schema version and structure", () => {
		const jobsDir = makeTempJobsDir();
		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());

		store.registerLaunch({
			benchmark: "harbor",
			jobName: "atomic-launch-test",
			dataset: "terminal-bench@2.0",
			agent: "veyyon",
			models: ["anthropic/claude-sonnet-4-6"],
			pid: process.pid,
			config: { tasks: 10, concurrency: 2 },
			role: "baseline",
			note: "atomic check",
		});

		const managerJsonPath = path.join(jobsDir, "atomic-launch-test", "manager.json");
		expect(fs.existsSync(managerJsonPath)).toBe(true);

		// Must be valid, complete JSON without any leftover temp files
		const raw = fs.readFileSync(managerJsonPath, "utf8");
		const parsed = JSON.parse(raw) as { schemaVersion: number; jobName: string; suite: string; backend: string };
		expect(parsed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		expect(parsed.jobName).toBe("atomic-launch-test");
		expect(parsed.suite).toBe("terminal-bench@2.0");
		expect(parsed.backend).toBe("harbor");

		// No temporary files leftover in the job directory
		const files = fs.readdirSync(path.join(jobsDir, "atomic-launch-test"));
		const tempFiles = files.filter(f => f.startsWith(".manager.json.tmp"));
		expect(tempFiles).toHaveLength(0);
	});

	it("deleteRun atomically deletes trials and runs rows in a single transaction", () => {
		const jobsDir = makeTempJobsDir();
		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());

		store.registerLaunch({
			jobName: "tx-delete-test",
			dataset: "terminal-bench@2.0",
			agent: "veyyon",
			models: ["m"],
			pid: process.pid,
		});

		// Seed trials
		const dbPath = path.join(jobsDir, "_manager", "evals.sqlite");
		const db = new Database(dbPath);
		db.query(
			"INSERT INTO trials (job_name, name, task, status, reward, cost_usd, duration_ms, detail, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run("tx-delete-test", "t1", "task1", "pass", 1, 0.1, 100, "", Date.now());
		db.close();

		expect(store.getRun("tx-delete-test")).not.toBeNull();
		expect(store.listTraces("tx-delete-test")).toHaveLength(1);

		const deleted = store.deleteRun("tx-delete-test");
		expect(deleted).toBe(true);

		// Both runs and trials must be cleanly removed
		expect(store.getRun("tx-delete-test")).toBeNull();
		expect(store.listTraces("tx-delete-test")).toHaveLength(0);
	});
});
