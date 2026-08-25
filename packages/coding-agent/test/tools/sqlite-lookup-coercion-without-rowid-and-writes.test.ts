/**
 * sqlite.test.ts drives ReadTool through INTEGER / TEXT PK and notes:rowid.
 * It never opens a WITHOUT ROWID table, never looks up a REAL PK from a path
 * key, never inserts DEFAULT VALUES from `{}`, and never runs q= with a `?`.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
	executeReadQuery,
	getRowByKey,
	getRowByRowId,
	insertRow,
	resolveTableRowLookup,
	updateRowByKey,
} from "@veyyon/coding-agent/tools/sqlite-reader";

describe("WITHOUT ROWID has no rowid fallback", () => {
	it("still uses a single-column TEXT PK", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID");
			expect(resolveTableRowLookup(db, "kv")).toEqual({ kind: "pk", column: "k", type: "TEXT" });
		} finally {
			db.close();
		}
	});

	it("throws on a composite PK rather than inventing a rowid", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE kv (a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY (a, b)) WITHOUT ROWID");
			expect(() => resolveTableRowLookup(db, "kv")).toThrow(/composite primary key; use '\?where='/i);
		} finally {
			db.close();
		}
	});
});

describe("path-key coercion follows the declared type string, not JS typeof", () => {
	it("parses a REAL PK from the path", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE measures (x REAL PRIMARY KEY, label TEXT)");
			db.run("INSERT INTO measures (x, label) VALUES (1.5, 'mid')");
			expect(getRowByKey(db, "measures", { column: "x", type: "REAL" }, "1.5")).toEqual({
				x: 1.5,
				label: "mid",
			});
		} finally {
			db.close();
		}
	});

	it("does not coerce a TEXT PK even when the value looks like an integer", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE slugs (slug TEXT PRIMARY KEY, title TEXT)");
			db.run("INSERT INTO slugs (slug, title) VALUES ('42', 'fortytwo')");
			db.run("INSERT INTO slugs (slug, title) VALUES ('042', 'padded')");
			expect(getRowByKey(db, "slugs", { column: "slug", type: "TEXT" }, "42")?.title).toBe("fortytwo");
			expect(getRowByKey(db, "slugs", { column: "slug", type: "TEXT" }, "042")?.title).toBe("padded");
		} finally {
			db.close();
		}
	});

	it("refuses a non-integer path key against INTEGER, including 1e2 scientific rowid", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
			expect(() => getRowByKey(db, "t", { column: "id", type: "INTEGER" }, "1.5")).toThrow(
				/must be an integer/i,
			);
			db.run("CREATE TABLE notes (body TEXT NOT NULL)");
			expect(() => getRowByRowId(db, "notes", "1e2")).toThrow(/must be an integer/i);
		} finally {
			db.close();
		}
	});
});

describe("write helpers that ReadTool never hits", () => {
	it("inserts DEFAULT VALUES when the JSON object is empty", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT DEFAULT 'x')");
			insertRow(db, "t", {});
			expect((db.prepare("SELECT v FROM t").get() as { v: string }).v).toBe("x");
		} finally {
			db.close();
		}
	});

	it("refuses an empty update and a nested object cell", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
			db.run("INSERT INTO t (id, v) VALUES (1, 'a')");
			expect(() => updateRowByKey(db, "t", { column: "id", type: "INTEGER" }, "1", {})).toThrow(
				/require at least one column value/i,
			);
			expect(() => insertRow(db, "t", { v: { nested: true } })).toThrow(
				/only accepts JSON scalar values or null/i,
			);
		} finally {
			db.close();
		}
	});

	it("refuses a raw statement that still has a bind slot — q= has no parameters", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE t (id INTEGER PRIMARY KEY)");
			expect(() => executeReadQuery(db, "SELECT * FROM t WHERE id = ?")).toThrow(
				/do not support bound parameters/i,
			);
		} finally {
			db.close();
		}
	});
});
