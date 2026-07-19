import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { initBeam } from "@veyyon/mnemopi/core/beam";

type ColumnRow = { name: string };

function columns(db: Database, table: string): Set<string> {
	const rows = db.query(`PRAGMA table_info(${table})`).all() as ColumnRow[];
	return new Set(rows.map(row => row.name));
}

describe("beam schema migration", () => {
	it("adds every missing column and backfills consolidated_at on a legacy working_memory table", () => {
		const db = new Database(":memory:");
		try {
			// A pre-e-series working_memory: only the original id/content columns, none
			// of the columns later runs add (veracity, memory_type, embed_text,
			// consolidated_at). initBeam's CREATE TABLE IF NOT EXISTS leaves this table
			// alone, so the addColumnIfMissing ALTER path must run for each one.
			db.run(
				"CREATE TABLE working_memory (id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT, session_id TEXT, timestamp TEXT)",
			);
			db.run("INSERT INTO working_memory (id, content) VALUES ('m1', 'legacy row')");

			initBeam(db);

			const cols = columns(db, "working_memory");
			// The ALTER path added each column that the legacy table lacked.
			for (const added of ["veracity", "memory_type", "embed_text", "consolidated_at"]) {
				expect(cols.has(added), `working_memory should gain ${added}`).toBe(true);
			}

			// consolidatedAtAdded was true, so the legacy row was backfilled to a real
			// ISO timestamp rather than left NULL.
			const row = db.query("SELECT consolidated_at FROM working_memory WHERE id = 'm1'").get() as {
				consolidated_at: string | null;
			};
			expect(typeof row.consolidated_at).toBe("string");
			expect(row.consolidated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		} finally {
			db.close();
		}
	});

	it("leaves a fresh schema untouched and never re-backfills consolidated_at", () => {
		const db = new Database(":memory:");
		try {
			// Fresh init: the base CREATE TABLE already carries every column, so no ALTER
			// runs and consolidatedAtAdded is false. A brand-new row keeps its NULL
			// consolidated_at (the migration UPDATE must not fire on fresh databases).
			initBeam(db);
			db.run("INSERT INTO working_memory (id, content) VALUES ('m2', 'fresh row')");

			// A second init is a no-op: every column already exists, so it stays green
			// and adds nothing.
			initBeam(db);

			const row = db.query("SELECT consolidated_at FROM working_memory WHERE id = 'm2'").get() as {
				consolidated_at: string | null;
			};
			expect(row.consolidated_at).toBeNull();
		} finally {
			db.close();
		}
	});
});
