import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { tableExists } from "../src/sqlite";

// One in-memory database per assertion group; each closes in afterEach so a
// leaked handle can never mask the closed-handle propagation test below.
let db: Database | undefined;

afterEach(() => {
	db?.close();
	db = undefined;
});

describe("tableExists", () => {
	it("finds a regular table by name and rejects an unknown name", () => {
		db = new Database(":memory:");
		db.run("CREATE TABLE history (id INTEGER PRIMARY KEY, body TEXT)");

		expect(tableExists(db, "history")).toBe(true);
		expect(tableExists(db, "missing")).toBe(false);
	});

	it("finds a view", () => {
		db = new Database(":memory:");
		db.run("CREATE TABLE base (id INTEGER PRIMARY KEY, n INTEGER)");
		db.run("CREATE VIEW positives AS SELECT id FROM base WHERE n > 0");

		expect(tableExists(db, "positives")).toBe(true);
	});

	it("finds an FTS5 virtual table, which sqlite_master records as type='table'", () => {
		db = new Database(":memory:");
		db.run("CREATE VIRTUAL TABLE history_fts USING fts5(body)");

		// Lock the fact the shared query depends on: FTS5 (and other module)
		// virtual tables are stored with type='table', not 'virtual table', so
		// `type IN ('table','view')` is the correct inclusive existence check.
		const row = db.query("SELECT type FROM sqlite_master WHERE name = ?").get("history_fts") as { type: string };
		expect(row.type).toBe("table");
		expect(tableExists(db, "history_fts")).toBe(true);
	});

	it("does not count an index as a queryable table", () => {
		db = new Database(":memory:");
		db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, k TEXT)");
		db.run("CREATE INDEX t_k ON t (k)");

		expect(tableExists(db, "t_k")).toBe(false);
		expect(tableExists(db, "t")).toBe(true);
	});

	it("propagates the error from a closed handle instead of reporting the table as missing", () => {
		const closed = new Database(":memory:");
		closed.run("CREATE TABLE history (id INTEGER PRIMARY KEY)");
		closed.close();

		// A closed or broken handle must not degrade silently to "table missing":
		// that would disable whole features without a trace. The query error
		// surfaces to the caller.
		expect(() => tableExists(closed, "history")).toThrow();
	});
});
