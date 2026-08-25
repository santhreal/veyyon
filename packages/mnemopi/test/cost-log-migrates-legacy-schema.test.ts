import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { COST_LOG_SCHEMA_VERSION, getCostStats, logCost } from "@veyyon/mnemopi/core/cost-log";
import { TempDir } from "@veyyon/utils";

describe("cost-log schema migration", () => {
	let tempDir: TempDir;

	beforeEach(async () => {
		tempDir = await TempDir.create("cost-log-migration-test-");
	});

	afterEach(async () => {
		await tempDir.remove();
	});

	it("migrates a legacy cost_entries table missing the model column and allows writes and reads", async () => {
		const dbPath = path.join(tempDir.path(), "cost_log.db");
		// Seed a legacy database created before the model column was added
		const legacy = new Database(dbPath);
		legacy.exec(`
			CREATE TABLE cost_entries (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT,
				memory_count INTEGER,
				token_count INTEGER,
				estimated_cost_usd REAL,
				timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			);
			INSERT INTO cost_entries (session_id, memory_count, token_count, estimated_cost_usd)
			VALUES ('session-legacy', 5, 250, 0.005);
		`);
		legacy.close();

		// Writing cost to the legacy database should migrate the table and succeed
		logCost("session-new", 10, 500, 0.01, "my-custom-model", dbPath);

		// Verify that the PRAGMA user_version is now updated
		const conn = new Database(dbPath);
		try {
			const versionRow = conn.query("PRAGMA user_version").get() as { user_version: number };
			expect(versionRow.user_version).toBe(COST_LOG_SCHEMA_VERSION);

			const rows = conn
				.query(
					"SELECT session_id, memory_count, token_count, estimated_cost_usd, model FROM cost_entries ORDER BY id ASC",
				)
				.all() as Array<{
				session_id: string;
				memory_count: number;
				token_count: number;
				estimated_cost_usd: number;
				model: string;
			}>;

			expect(rows).toHaveLength(2);
			expect(rows[0]?.session_id).toBe("session-legacy");
			expect(rows[0]?.model).toBe("default");
			expect(rows[1]?.session_id).toBe("session-new");
			expect(rows[1]?.model).toBe("my-custom-model");

			// Check aggregated stats
			const stats = getCostStats(undefined, dbPath);
			expect(stats.total_calls).toBe(2);
			expect(stats.total_memories_injected).toBe(15);
			expect(stats.total_tokens).toBe(750);
		} finally {
			conn.close();
		}
	});
});
