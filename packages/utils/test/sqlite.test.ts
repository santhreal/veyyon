import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { escapeLike, sqlPlaceholders, tableExists } from "../src/sqlite";

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

describe("sqlPlaceholders", () => {
	it("builds a comma-separated run of the requested count", () => {
		expect(sqlPlaceholders(1)).toBe("?");
		expect(sqlPlaceholders(3)).toBe("?, ?, ?");
	});

	it("returns an empty string for a count of 0 (caller must guard IN ())", () => {
		expect(sqlPlaceholders(0)).toBe("");
	});

	it("binds cleanly in a real IN clause", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE t (id INTEGER)");
			for (const id of [1, 2, 3, 4]) db.run("INSERT INTO t (id) VALUES (?)", [id]);
			const wanted = [2, 4];
			const rows = db
				.query(`SELECT id FROM t WHERE id IN (${sqlPlaceholders(wanted.length)}) ORDER BY id`)
				.all(...wanted) as Array<{ id: number }>;
			expect(rows.map(r => r.id)).toEqual([2, 4]);
		} finally {
			db.close();
		}
	});

	it("throws on a negative or non-integer count", () => {
		expect(() => sqlPlaceholders(-1)).toThrow(RangeError);
		expect(() => sqlPlaceholders(2.5)).toThrow(RangeError);
		expect(() => sqlPlaceholders(Number.NaN)).toThrow(RangeError);
	});
});

describe("escapeLike", () => {
	it("prefixes each LIKE metacharacter with a backslash", () => {
		expect(escapeLike("100%")).toBe("100\\%");
		expect(escapeLike("a_b")).toBe("a\\_b");
		expect(escapeLike("c:\\dir")).toBe("c:\\\\dir");
		expect(escapeLike("50%_of\\it")).toBe("50\\%\\_of\\\\it");
	});

	it("leaves ordinary text untouched", () => {
		expect(escapeLike("plain text 123")).toBe("plain text 123");
		expect(escapeLike("")).toBe("");
	});

	it("makes a wildcard in the search term match literally under ESCAPE '\\'", () => {
		db = new Database(":memory:");
		db.run("CREATE TABLE t (label TEXT)");
		for (const label of ["50% off", "500 items", "5_0", "540"]) {
			db.run("INSERT INTO t (label) VALUES (?)", [label]);
		}

		// Searching for "50%" must find only the literal "50% off" row, not the
		// "500 items" / "540" rows a bare `%` wildcard would also match.
		const pctRows = db
			.query("SELECT label FROM t WHERE label LIKE ? ESCAPE '\\' ORDER BY label")
			.all(`%${escapeLike("50%")}%`) as Array<{ label: string }>;
		expect(pctRows.map(r => r.label)).toEqual(["50% off"]);

		// The literal underscore in "5_0" must not match "540" the way a raw
		// `_` single-character wildcard would.
		const underRows = db
			.query("SELECT label FROM t WHERE label LIKE ? ESCAPE '\\'")
			.all(`%${escapeLike("5_0")}%`) as Array<{ label: string }>;
		expect(underRows.map(r => r.label)).toEqual(["5_0"]);
	});
});
