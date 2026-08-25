/**
 * parseSqliteSelector is the only parser between a sqlite:// remainder and
 * queryRows / getRowByKey. Several of its refusals are unreachable from the
 * happy path in sqlite.test.ts:
 *
 * - `q` is exclusive. A table selector or any other query key next to it
 *   would otherwise let pagination and raw SQL both run.
 * - An empty `q=` is not a list. Listing is the no-query, no-table shape.
 * - Query params without a table are not a raw query (that is `q=`).
 * - Row lookups (`table:key`) cannot carry pagination; the key is the whole
 *   selector.
 * - `order=` uses lastIndexOf(":") so a column whose name contains a colon
 *   (`created:at`) is parsed as column=`created:at` + direction. That is
 *   either a schema hit or a "column not found" — never "direction=at:desc".
 * - limit=0 / negative / non-integer refuse. limit larger than 500 clamps.
 *   An omitted limit on a query-shaped selector defaults to 20.
 * - `users:` with an empty key is not a row lookup (key.length === 0).
 * - Leading colons on the table are stripped (`::users` → users).
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { parseSqliteSelector, queryRows } from "@veyyon/coding-agent/tools/sqlite-reader";

describe("raw q= cannot be combined with a table or with pagination", () => {
	it("refuses q= next to a table selector", () => {
		expect(() => parseSqliteSelector("users", "q=SELECT+1")).toThrow(
			/cannot be combined with table selectors or pagination/i,
		);
	});

	it("refuses q= next to limit=", () => {
		expect(() => parseSqliteSelector("", "q=SELECT+1&limit=2")).toThrow(
			/cannot be combined with table selectors or pagination/i,
		);
	});

	it("refuses q= next to where=", () => {
		expect(() => parseSqliteSelector("", "q=SELECT+1&where=1")).toThrow(
			/cannot be combined with table selectors or pagination/i,
		);
	});

	it("refuses an empty q=", () => {
		expect(() => parseSqliteSelector("", "q=")).toThrow(/cannot be empty/i);
	});

	it("refuses a whitespace-only q=", () => {
		expect(() => parseSqliteSelector("", "q=+++")).toThrow(/cannot be empty/i);
	});

	it("accepts a lone q= as raw SQL, decoding plus as space", () => {
		expect(parseSqliteSelector("", "q=SELECT+1")).toEqual({ kind: "raw", sql: "SELECT 1" });
	});
});

describe("query parameters without a table are not a list and not raw SQL", () => {
	it("refuses limit= on an empty table selector", () => {
		expect(() => parseSqliteSelector("", "limit=2")).toThrow(
			/require a table selector or q=SELECT/i,
		);
	});

	it("refuses where= on an empty table selector", () => {
		expect(() => parseSqliteSelector("", "where=1")).toThrow(
			/require a table selector or q=SELECT/i,
		);
	});

	it("lists when both the table and the query string are empty", () => {
		expect(parseSqliteSelector("", "")).toEqual({ kind: "list" });
	});
});

describe("row lookups refuse query parameters; empty keys are not lookups", () => {
	it("refuses users:42?limit=1", () => {
		expect(() => parseSqliteSelector("users:42", "limit=1")).toThrow(
			/row lookups cannot be combined with query parameters/i,
		);
	});

	it("refuses users:42?where=1=1", () => {
		expect(() => parseSqliteSelector("users:42", "where=1=1")).toThrow(
			/row lookups cannot be combined with query parameters/i,
		);
	});

	it("treats users: (empty key) as a schema selector, not a row lookup", () => {
		expect(parseSqliteSelector("users:", "")).toEqual({
			kind: "schema",
			table: "users",
			sampleLimit: 5,
		});
	});

	it("strips leading colons so ::users is the users table", () => {
		expect(parseSqliteSelector("::users", "")).toEqual({
			kind: "schema",
			table: "users",
			sampleLimit: 5,
		});
	});

	it("treats a selector that is only colons as a list — stripping them leaves no table and no params", () => {
		expect(parseSqliteSelector("::", "")).toEqual({ kind: "list" });
	});
});

describe("unsupported query keys refuse even when a known key is also present", () => {
	it("refuses foo=1 on a bare table (would otherwise look like schema)", () => {
		expect(() => parseSqliteSelector("users", "foo=1")).toThrow(/Unsupported SQLite query parameter 'foo'/i);
	});

	it("refuses foo=1 next to a valid limit=", () => {
		expect(() => parseSqliteSelector("users", "limit=2&foo=1")).toThrow(
			/Unsupported SQLite query parameter 'foo'/i,
		);
	});
});

describe("limit and offset parsing through the selector", () => {
	it("defaults limit to 20 when only where= is present", () => {
		const sel = parseSqliteSelector("users", "where=1=1");
		expect(sel).toEqual({
			kind: "query",
			table: "users",
			limit: 20,
			offset: 0,
			order: undefined,
			where: "1=1",
		});
	});

	it("clamps limit=9999 to 500", () => {
		const sel = parseSqliteSelector("users", "limit=9999");
		expect(sel.kind).toBe("query");
		if (sel.kind !== "query") throw new Error("expected query");
		expect(sel.limit).toBe(500);
	});

	it("refuses limit=0 — a page of nothing is not a positive integer", () => {
		expect(() => parseSqliteSelector("users", "limit=0")).toThrow(/positive integer/i);
	});

	it("refuses limit=-3", () => {
		expect(() => parseSqliteSelector("users", "limit=-3")).toThrow(/positive integer/i);
	});

	it("refuses limit=nope", () => {
		expect(() => parseSqliteSelector("users", "limit=nope")).toThrow(/positive integer/i);
	});

	it("treats limit= as omitted and uses the default 20", () => {
		const sel = parseSqliteSelector("users", "limit=");
		expect(sel.kind).toBe("query");
		if (sel.kind !== "query") throw new Error("expected query");
		expect(sel.limit).toBe(20);
	});

	it("parses limit=1.9 as 1 (parseInt, not Number)", () => {
		const sel = parseSqliteSelector("users", "limit=1.9");
		expect(sel.kind).toBe("query");
		if (sel.kind !== "query") throw new Error("expected query");
		expect(sel.limit).toBe(1);
	});

	it("refuses offset=-1", () => {
		expect(() => parseSqliteSelector("users", "offset=-1")).toThrow(/non-negative integer/i);
	});

	it("accepts offset=0", () => {
		const sel = parseSqliteSelector("users", "offset=0");
		expect(sel.kind).toBe("query");
		if (sel.kind !== "query") throw new Error("expected query");
		expect(sel.offset).toBe(0);
	});
});

describe("order= splits on the last colon, not the first", () => {
	it("treats created:desc as column created, direction desc", () => {
		const sel = parseSqliteSelector("users", "order=created:desc");
		expect(sel.kind).toBe("query");
		if (sel.kind !== "query") throw new Error("expected query");
		expect(sel.order).toBe("created:desc");
	});

	it("accepts DESC in mixed case because the runner lowercases the direction", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, created INTEGER)");
			db.run("INSERT INTO users (id, created) VALUES (1, 10)");
			db.run("INSERT INTO users (id, created) VALUES (2, 20)");
			const rows = queryRows(db, "users", { limit: 2, offset: 0, order: "created:DESC" });
			expect(rows.rows.map(r => r.id)).toEqual([2, 1]);
		} finally {
			db.close();
		}
	});

	it("refuses a direction that is not asc/desc after the last colon", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, created INTEGER)");
			expect(() => queryRows(db, "users", { limit: 2, offset: 0, order: "created:up" })).toThrow(
				/must be 'asc' or 'desc'/i,
			);
		} finally {
			db.close();
		}
	});

	it("refuses order=created:at:desc because the column is parsed as created:at, which is not in the schema", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, created INTEGER)");
			expect(() => queryRows(db, "users", { limit: 2, offset: 0, order: "created:at:desc" })).toThrow(
				/order column 'created:at' not found/i,
			);
		} finally {
			db.close();
		}
	});

	it("orders by a column whose name actually contains a colon when that column exists", () => {
		const db = new Database(":memory:");
		try {
			db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, "created:at" INTEGER)');
			db.run('INSERT INTO users (id, "created:at") VALUES (1, 10)');
			db.run('INSERT INTO users (id, "created:at") VALUES (2, 20)');
			const rows = queryRows(db, "users", { limit: 2, offset: 0, order: "created:at:desc" });
			expect(rows.rows.map(r => r.id)).toEqual([2, 1]);
		} finally {
			db.close();
		}
	});

	it("refuses an order column that is not in the table even when the direction is valid", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE users (id INTEGER PRIMARY KEY)");
			expect(() => queryRows(db, "users", { limit: 1, offset: 0, order: "nope:asc" })).toThrow(
				/order column 'nope' not found/i,
			);
		} finally {
			db.close();
		}
	});
});
