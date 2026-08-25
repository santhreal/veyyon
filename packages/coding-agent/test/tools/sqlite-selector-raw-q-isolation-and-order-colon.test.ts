/**
 * sqlite.test.ts accepts `q=SELECT+1` and `order=created:desc`. It does not pin
 * exclusivity (q= vs table/pagination), empty q=, `users:` as schema, or
 * lastIndexOf(":") on an order column that itself contains a colon.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { parseSqliteSelector, queryRows } from "@veyyon/coding-agent/tools/sqlite-reader";

describe("raw q= is exclusive and cannot be empty", () => {
	it("refuses q= next to a table selector or pagination", () => {
		expect(() => parseSqliteSelector("users", "q=SELECT+1")).toThrow(
			/cannot be combined with table selectors or pagination/i,
		);
		expect(() => parseSqliteSelector("", "q=SELECT+1&limit=2")).toThrow(
			/cannot be combined with table selectors or pagination/i,
		);
	});

	it("refuses empty and plus-only q= (plus is space, so q=+++ is whitespace)", () => {
		expect(() => parseSqliteSelector("", "q=")).toThrow(/cannot be empty/i);
		expect(() => parseSqliteSelector("", "q=+++")).toThrow(/cannot be empty/i);
	});

	it("refuses pagination without a table — that is not a list and not raw SQL", () => {
		expect(() => parseSqliteSelector("", "limit=2")).toThrow(/require a table selector or q=SELECT/i);
	});
});

describe("row lookup vs schema vs leading colons", () => {
	it("refuses users:42?limit=1", () => {
		expect(() => parseSqliteSelector("users:42", "limit=1")).toThrow(
			/row lookups cannot be combined with query parameters/i,
		);
	});

	it("treats users: (empty key) as schema, not a row lookup of ''", () => {
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
});

describe("limit=0 is refused; limit=1.9 is parseInt 1; 9999 clamps to 500", () => {
	it("refuses a page of nothing", () => {
		expect(() => parseSqliteSelector("users", "limit=0")).toThrow(/positive integer/i);
	});

	it("uses parseInt, not Number, so 1.9 is 1 and 1e2 is 1", () => {
		const sel = parseSqliteSelector("users", "limit=1.9");
		expect(sel.kind).toBe("query");
		if (sel.kind !== "query") throw new Error("expected query");
		expect(sel.limit).toBe(1);
	});

	it("clamps above 500", () => {
		const sel = parseSqliteSelector("users", "limit=9999");
		expect(sel.kind).toBe("query");
		if (sel.kind !== "query") throw new Error("expected query");
		expect(sel.limit).toBe(500);
	});
});

describe("order= splits on the last colon", () => {
	it("treats created:at:desc as column created:at, not direction at:desc", () => {
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

	it("orders by a quoted column whose name contains a colon", () => {
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
});
