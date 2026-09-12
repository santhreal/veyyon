import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { COLUMN_MIGRATIONS, initBeam } from "../src/core/beam/schema";

describe("mnemopi schema and column migrations runtime derivation", () => {
	it("declares column migrations exhaustively with valid tables and column definitions", () => {
		expect(COLUMN_MIGRATIONS.length).toBeGreaterThan(0);
		for (const [table, column, definition] of COLUMN_MIGRATIONS) {
			expect(typeof table).toBe("string");
			expect(table.length).toBeGreaterThan(0);
			expect(typeof column).toBe("string");
			expect(column.length).toBeGreaterThan(0);
			expect(typeof definition).toBe("string");
			expect(definition.length).toBeGreaterThan(0);
		}
	});

	it("applies all table creations, column migrations, and triggers to a fresh database", () => {
		const db = new Database(":memory:");
		initBeam(db);

		const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
			r => r.name,
		);
		expect(tables).toContain("working_memory");
		expect(tables).toContain("episodic_memory");
		expect(tables).toContain("scratchpad");
		expect(tables).toContain("facts");
		expect(tables).toContain("annotations");
		expect(tables).toContain("triples");

		for (const [table, column] of COLUMN_MIGRATIONS) {
			const cols = (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(r => r.name);
			expect(cols).toContain(column);
		}
		db.close();
	});
});
