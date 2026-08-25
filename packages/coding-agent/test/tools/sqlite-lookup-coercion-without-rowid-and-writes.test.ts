/**
 * Row lookup coercion and write helpers sit behind ReadTool/WriteTool and
 * were never called except through integer PK / text PK / empty-content
 * delete. The type arm is `type.includes("INT")` / REAL|FLOA|DOUB, then
 * string. WITHOUT ROWID tables refuse rowid fallback. An empty JSON object
 * insert is DEFAULT VALUES. An empty update refuses. Raw SQL with a `?`
 * is refused (no bound parameters on q=). Composite PK already has a
 * ReadTool test; this file pins resolveTableRowLookup itself so a renderer
 * change cannot hide the throw.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
	deleteRowByKey,
	deleteRowByRowId,
	executeReadQuery,
	getRowByKey,
	getRowByRowId,
	getTablePrimaryKey,
	insertRow,
	MAX_RAW_QUERY_ROWS,
	resolveTableRowLookup,
	updateRowByKey,
	updateRowByRowId,
} from "@veyyon/coding-agent/tools/sqlite-reader";

describe("resolveTableRowLookup", () => {
	it("returns pk for a single INTEGER primary key, including the declared type string", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
			expect(resolveTableRowLookup(db, "t")).toEqual({ kind: "pk", column: "id", type: "INTEGER" });
			expect(getTablePrimaryKey(db, "t")).toEqual({ column: "id", type: "INTEGER" });
		} finally {
			db.close();
		}
	});

	it("returns rowid when there is no declared PK", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE notes (body TEXT NOT NULL)");
			expect(resolveTableRowLookup(db, "notes")).toEqual({ kind: "rowid" });
			expect(getTablePrimaryKey(db, "notes")).toBeNull();
		} finally {
			db.close();
		}
	});

	it("throws on a composite primary key and tells the caller to use where=", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE pair (a INTEGER NOT NULL, b INTEGER NOT NULL, PRIMARY KEY (a, b))");
			expect(() => resolveTableRowLookup(db, "pair")).toThrow(/composite primary key; use '\?where='/i);
			expect(getTablePrimaryKey(db, "pair")).toBeNull();
		} finally {
			db.close();
		}
	});

	it("still uses the TEXT PK on a WITHOUT ROWID table that has a single-column primary key", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID");
			// Single TEXT PK: this is a pk lookup, not rowid. WITHOUT ROWID only
			// matters when there is no single PK.
			expect(resolveTableRowLookup(db, "kv")).toEqual({ kind: "pk", column: "k", type: "TEXT" });
		} finally {
			db.close();
		}
	});

	it("throws on WITHOUT ROWID with no single-column PK", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE kv (a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY (a, b)) WITHOUT ROWID");
			expect(() => resolveTableRowLookup(db, "kv")).toThrow(/composite primary key; use '\?where='/i);
		} finally {
			db.close();
		}
	});
});

describe("getRowByKey type coercion", () => {
	it("looks up a REAL primary key by parsing the path key as a number", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE measures (x REAL PRIMARY KEY, label TEXT)");
			db.run("INSERT INTO measures (x, label) VALUES (1.5, 'mid')");
			const row = getRowByKey(db, "measures", { column: "x", type: "REAL" }, "1.5");
			expect(row).toEqual({ x: 1.5, label: "mid" });
		} finally {
			db.close();
		}
	});

	it("looks up a FLOAT-declared key the same way (type string contains FLOA)", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE measures (x FLOAT PRIMARY KEY, label TEXT)");
			db.run("INSERT INTO measures (x, label) VALUES (2.25, 'q')");
			const row = getRowByKey(db, "measures", { column: "x", type: "FLOAT" }, "2.25");
			expect(row?.label).toBe("q");
		} finally {
			db.close();
		}
	});

	it("looks up a DOUBLE-declared key (type string contains DOUB)", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE measures (x DOUBLE PRIMARY KEY, label TEXT)");
			db.run("INSERT INTO measures (x, label) VALUES (3, 'd')");
			const row = getRowByKey(db, "measures", { column: "x", type: "DOUBLE" }, "3");
			expect(row?.label).toBe("d");
		} finally {
			db.close();
		}
	});

	it("does not coerce a TEXT primary key even when the value looks like an integer", () => {
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

	it("refuses a non-integer key against an INTEGER PK rather than falling through to string compare", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
			expect(() => getRowByKey(db, "t", { column: "id", type: "INTEGER" }, "1.5")).toThrow(
				/must be an integer/i,
			);
			expect(() => getRowByKey(db, "t", { column: "id", type: "INTEGER" }, "abc")).toThrow(
				/must be an integer/i,
			);
		} finally {
			db.close();
		}
	});

	it("accepts a negative INTEGER PK", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
			db.run("INSERT INTO t (id, v) VALUES (-3, 'neg')");
			expect(getRowByKey(db, "t", { column: "id", type: "INTEGER" }, "-3")?.v).toBe("neg");
		} finally {
			db.close();
		}
	});

	it("INT (not INTEGER) still takes the integer arm because the type string contains INT", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE t (id INT PRIMARY KEY, v TEXT)");
			db.run("INSERT INTO t (id, v) VALUES (9, 'n')");
			expect(getRowByKey(db, "t", { column: "id", type: "INT" }, "9")?.v).toBe("n");
		} finally {
			db.close();
		}
	});
});

describe("rowid lookup", () => {
	it("returns the first inserted row as rowid 1", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE notes (body TEXT NOT NULL)");
			db.run("INSERT INTO notes (body) VALUES ('alpha')");
			db.run("INSERT INTO notes (body) VALUES ('beta')");
			expect(getRowByRowId(db, "notes", "1")?.body).toBe("alpha");
			expect(getRowByRowId(db, "notes", "2")?.body).toBe("beta");
		} finally {
			db.close();
		}
	});

	it("refuses a non-integer rowid", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE notes (body TEXT NOT NULL)");
			expect(() => getRowByRowId(db, "notes", "1e2")).toThrow(/must be an integer/i);
		} finally {
			db.close();
		}
	});
});

describe("insert / update / delete helpers", () => {
	it("inserts DEFAULT VALUES when the JSON object is empty", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT DEFAULT 'x')");
			insertRow(db, "t", {});
			const row = db.prepare("SELECT v FROM t").get() as { v: string };
			expect(row.v).toBe("x");
		} finally {
			db.close();
		}
	});

	it("refuses a write to a column that does not exist", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
			expect(() => insertRow(db, "t", { nope: 1 })).toThrow(/no column named 'nope'/i);
		} finally {
			db.close();
		}
	});

	it("refuses a nested object as a cell value — only JSON scalars or null", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
			expect(() => insertRow(db, "t", { v: { nested: true } })).toThrow(/only accepts JSON scalar values or null/i);
		} finally {
			db.close();
		}
	});

	it("accepts null as a cell value", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
			insertRow(db, "t", { v: null });
			const row = db.prepare("SELECT v FROM t").get() as { v: unknown };
			expect(row.v).toBeNull();
		} finally {
			db.close();
		}
	});

	it("accepts boolean and bigint scalars on insert", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, flag INTEGER, wide INTEGER)");
			insertRow(db, "t", { flag: true, wide: 3n });
			const row = db.prepare("SELECT flag, wide FROM t").get() as { flag: number; wide: number };
			expect(row.flag).toBe(1);
			expect(row.wide).toBe(3);
		} finally {
			db.close();
		}
	});

	it("refuses an update whose object has no columns", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
			db.run("INSERT INTO t (id, v) VALUES (1, 'a')");
			expect(() => updateRowByKey(db, "t", { column: "id", type: "INTEGER" }, "1", {})).toThrow(
				/require at least one column value/i,
			);
			expect(() => updateRowByRowId(db, "t", "1", {})).toThrow(/require at least one column value/i);
		} finally {
			db.close();
		}
	});

	it("updates by INTEGER PK and reports 1 change", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
			db.run("INSERT INTO t (id, v) VALUES (1, 'a')");
			expect(updateRowByKey(db, "t", { column: "id", type: "INTEGER" }, "1", { v: "b" })).toBe(1);
			expect(getRowByKey(db, "t", { column: "id", type: "INTEGER" }, "1")?.v).toBe("b");
		} finally {
			db.close();
		}
	});

	it("deletes by PK and by rowid and reports changes", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
			db.run("INSERT INTO t (id, v) VALUES (1, 'a')");
			db.run("INSERT INTO t (id, v) VALUES (2, 'b')");
			expect(deleteRowByKey(db, "t", { column: "id", type: "INTEGER" }, "1")).toBe(1);
			expect(deleteRowByRowId(db, "t", "2")).toBe(1);
			expect(db.prepare("SELECT COUNT(*) AS c FROM t").get()).toEqual({ c: 0 });
		} finally {
			db.close();
		}
	});

	it("quotes a table name that contains a double quote by doubling it", () => {
		const db = new Database(":memory:");
		try {
			db.run('CREATE TABLE "we""ird" (id INTEGER PRIMARY KEY, v TEXT)');
			insertRow(db, 'we"ird', { v: "ok" });
			expect(getRowByKey(db, 'we"ird', { column: "id", type: "INTEGER" }, "1")?.v).toBe("ok");
		} finally {
			db.close();
		}
	});
});

describe("executeReadQuery bound-parameter and cap contracts", () => {
	it("refuses a raw statement that still has a bind slot", () => {
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

	it("sets truncated when the result is longer than MAX_RAW_QUERY_ROWS", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE t (id INTEGER PRIMARY KEY)");
			const ins = db.prepare("INSERT INTO t DEFAULT VALUES");
			const fill = db.transaction(() => {
				for (let i = 0; i < MAX_RAW_QUERY_ROWS + 3; i++) ins.run();
			});
			fill();
			const result = executeReadQuery(db, "SELECT * FROM t");
			expect(result.truncated).toBe(true);
			expect(result.rows).toHaveLength(MAX_RAW_QUERY_ROWS);
		} finally {
			db.close();
		}
	});

	it("does not set truncated when the result fits", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE t (id INTEGER PRIMARY KEY)");
			db.run("INSERT INTO t DEFAULT VALUES");
			const result = executeReadQuery(db, "SELECT * FROM t");
			expect(result.truncated).toBe(false);
			expect(result.rows).toHaveLength(1);
		} finally {
			db.close();
		}
	});
});
