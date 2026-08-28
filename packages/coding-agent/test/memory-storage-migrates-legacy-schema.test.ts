import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	listStage1OutputsForGlobal,
	markGlobalPhase2Succeeded,
	openMemoryDb,
	upsertThreads,
} from "@veyyon/coding-agent/memory/storage";
import { TempDir } from "@veyyon/utils";

describe("memory storage schema migration", () => {
	let tempDir: TempDir;

	beforeEach(async () => {
		tempDir = await TempDir.create("memory-storage-migration-test-");
	});

	afterEach(async () => {
		await tempDir.remove();
	});

	it("migrates a legacy database created without newer columns and allows read and write operations", async () => {
		const dbPath = path.join(tempDir.path(), "storage.sqlite");
		// Seed a legacy database created with the initial bare CREATE TABLE statements
		// missing `cwd` / `source_kind` on threads, `rollout_slug` on stage1_outputs,
		// and `input_watermark` / `last_success_watermark` on jobs.
		const legacyDb = new Database(dbPath);
		legacyDb.exec(`
			CREATE TABLE threads (
				id TEXT PRIMARY KEY,
				updated_at INTEGER NOT NULL,
				rollout_path TEXT NOT NULL
			);

			CREATE TABLE stage1_outputs (
				thread_id TEXT PRIMARY KEY,
				source_updated_at INTEGER NOT NULL,
				raw_memory TEXT NOT NULL,
				rollout_summary TEXT NOT NULL,
				generated_at INTEGER NOT NULL
			);

			CREATE TABLE jobs (
				kind TEXT NOT NULL,
				job_key TEXT NOT NULL,
				status TEXT NOT NULL,
				worker_id TEXT,
				ownership_token TEXT,
				started_at INTEGER,
				finished_at INTEGER,
				lease_until INTEGER,
				retry_at INTEGER,
				retry_remaining INTEGER NOT NULL,
				last_error TEXT,
				PRIMARY KEY (kind, job_key)
			);
		`);

		// Insert legacy records
		legacyDb.exec(`
			INSERT INTO threads (id, updated_at, rollout_path) VALUES ('t-1', 1000, '/path/1');
			INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, generated_at)
			VALUES ('t-1', 1000, 'legacy raw memory', 'legacy summary', 1000);
			INSERT INTO jobs (kind, job_key, status, retry_remaining)
			VALUES ('memory_consolidate_global', 'global:/my-project', 'running', 3);
		`);
		legacyDb.close();

		// Now open the legacy database with the current openMemoryDb implementation
		const db = openMemoryDb(dbPath);
		try {
			// Verify PRAGMA user_version was set
			const versionRow = db.query("PRAGMA user_version").get() as { user_version: number };
			expect(versionRow.user_version).toBe(1);

			// Write path: upsertThreads should now successfully write with cwd and source_kind
			upsertThreads(db, [
				{
					id: "t-1",
					updatedAt: 2000,
					rolloutPath: "/path/1-updated",
					cwd: "/my-project",
					sourceKind: "cli",
				},
				{
					id: "t-2",
					updatedAt: 2500,
					rolloutPath: "/path/2",
					cwd: "/my-project",
					sourceKind: "cli",
				},
			]);

			// Read path: listStage1OutputsForGlobal queries stage1_outputs JOIN threads with rollout_slug and cwd
			const outputs = listStage1OutputsForGlobal(db, 10, "/my-project");
			expect(outputs.length).toBe(1);
			expect(outputs[0]?.threadId).toBe("t-1");
			expect(outputs[0]?.rolloutSummary).toBe("legacy summary");
			expect(outputs[0]?.cwd).toBe("/my-project");

			// Jobs update path: markGlobalPhase2Succeeded updates last_success_watermark
			const marked = markGlobalPhase2Succeeded(db, {
				ownershipToken: "",
				newWatermark: 500,
				nowSec: 3000,
				cwd: "/my-project",
			});
			// It ran the SQL without schema error (even if ownershipToken did not match running job)
			expect(typeof marked).toBe("boolean");
		} finally {
			db.close();
		}
	});
});
