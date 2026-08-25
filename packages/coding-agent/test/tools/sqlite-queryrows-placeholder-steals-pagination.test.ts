/**
 * queryRows always appends `LIMIT ? OFFSET ?`. The where= fragment is
 * interpolated, not bound. A `?` that SQLite treats as a parameter therefore
 * steals those two slots: `statement.paramsCount !== 2` and the helper
 * refuses rather than silently binding the agent's limit/offset into the
 * predicate.
 *
 * Quoted `?` is not a parameter. Named `:id` / `$id` are parameters in
 * bun:sqlite. Both must be pinned: one is the safe path, the other is the
 * same steal under a different sigil.
 *
 * WHY THIS IS NOT sqlite.test.ts. That file drives ReadTool through the path
 * selector and never calls queryRows. The paramsCount guard is unreachable
 * from parseSqliteSelector's keyword scanner: `id = ?` has no LIMIT/UNION
 * token, so the selector accepts it and only the runner refuses.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { queryRows } from "@veyyon/coding-agent/tools/sqlite-reader";

function users(): Database {
	const db = new Database(":memory:");
	db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT)");
	db.run("INSERT INTO users (id, name, note) VALUES (1, 'Ada', 'ok?')");
	db.run("INSERT INTO users (id, name, note) VALUES (2, 'Bob', 'plain')");
	return db;
}

describe("queryRows refuses a where= fragment that binds extra parameters", () => {
	it("refuses `id = ?` because that `?` is a third bind slot, not a comparison to a value", () => {
		const db = users();
		try {
			expect(() => queryRows(db, "users", { limit: 20, offset: 0, where: "id = ?" })).toThrow(
				/changed the expected pagination parameters/i,
			);
		} finally {
			db.close();
		}
	});

	it("refuses a named `:id` bind in where= — bun:sqlite counts named params too", () => {
		const db = users();
		try {
			expect(() => queryRows(db, "users", { limit: 20, offset: 0, where: "id = :id" })).toThrow(
				/changed the expected pagination parameters/i,
			);
		} finally {
			db.close();
		}
	});

	it("refuses a `$id` bind in where=", () => {
		const db = users();
		try {
			expect(() => queryRows(db, "users", { limit: 20, offset: 0, where: "id = $id" })).toThrow(
				/changed the expected pagination parameters/i,
			);
		} finally {
			db.close();
		}
	});
});

describe("queryRows does not treat a quoted question mark as a bind slot", () => {
	it("returns the row whose note is the two-character string ok?", () => {
		const db = users();
		try {
			const result = queryRows(db, "users", { limit: 20, offset: 0, where: "note = 'ok?'" });
			expect(result.totalCount).toBe(1);
			expect(result.rows).toEqual([{ id: 1, name: "Ada", note: "ok?" }]);
		} finally {
			db.close();
		}
	});

	it("returns the same row through double quotes (SQLite identifier vs string: this is a string)", () => {
		const db = users();
		try {
			const result = queryRows(db, "users", { limit: 20, offset: 0, where: `note = "ok?"` });
			expect(result.totalCount).toBe(1);
			expect(result.rows[0]?.name).toBe("Ada");
		} finally {
			db.close();
		}
	});
});
