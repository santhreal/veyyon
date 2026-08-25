/**
 * parseSqlitePathCandidates is a global /gi regex over the file path.
 * sqlite.test.ts already pins `data/app.db:users?limit=5` and `data/app.sqlite`.
 * Remaining:
 *
 * - `.db` mid-name (`notes.db.bak`) is not a database
 * - `.sqlite3` / `.db3` vs `.sqlite4`
 * - two extensions, longest sqlitePath first
 * - first `?` starts the query string even when a quoted `?` follows
 * - Windows separators stay on sqlitePath
 * - /gi lastIndex must not leak across calls
 */
import { describe, expect, it } from "bun:test";
import { parseSqlitePathCandidates } from "@veyyon/coding-agent/tools/sqlite-reader";

describe("extension must sit at a selector boundary, not mid-name", () => {
	it("does not treat notes.db.bak as a sqlite path", () => {
		expect(parseSqlitePathCandidates("notes.db.bak")).toEqual([]);
	});

	it("accepts .sqlite3 and .db3, not .sqlite4", () => {
		expect(parseSqlitePathCandidates("a.sqlite3:users")).toEqual([
			{ sqlitePath: "a.sqlite3", subPath: "users", queryString: "" },
		]);
		expect(parseSqlitePathCandidates("a.db3:users")).toEqual([
			{ sqlitePath: "a.db3", subPath: "users", queryString: "" },
		]);
		expect(parseSqlitePathCandidates("a.sqlite4")).toEqual([]);
	});
});

describe("two extensions in one path produce two candidates, longest first", () => {
	it("does not treat `.db/` as a database — the extension is not at `:`, `?`, or EOS", () => {
		expect(parseSqlitePathCandidates("dir.db/app.sqlite:users")).toEqual([
			{ sqlitePath: "dir.db/app.sqlite", subPath: "users", queryString: "" },
		]);
	});

	it("does emit two candidates when both extensions sit on a selector boundary", () => {
		const got = parseSqlitePathCandidates("dir.db:ignored/app.sqlite:users");
		expect(got.map(c => c.sqlitePath)).toEqual(["dir.db:ignored/app.sqlite", "dir.db"]);
		expect(got[1]).toEqual({ sqlitePath: "dir.db", subPath: "ignored/app.sqlite:users", queryString: "" });
	});
});

describe("remainder split: first `?` starts the query string", () => {
	it("parses a quoted ? inside where= as query-string, not a second selector", () => {
		expect(parseSqlitePathCandidates("app.sqlite:users?where=name='?'&limit=2")).toEqual([
			{
				sqlitePath: "app.sqlite",
				subPath: "users",
				queryString: "where=name='?'&limit=2",
			},
		]);
	});

	it("strips leading colons on the table after the extension", () => {
		expect(parseSqlitePathCandidates("app.sqlite:::users")).toEqual([
			{ sqlitePath: "app.sqlite", subPath: "users", queryString: "" },
		]);
	});
});

describe("backslash matching uses a normalized copy; sqlitePath is sliced from the original", () => {
	it("keeps Windows separators on sqlitePath when the input used them", () => {
		const got = parseSqlitePathCandidates("C:\\data\\app.sqlite:users");
		expect(got).toHaveLength(1);
		expect(got[0]?.sqlitePath).toBe("C:\\data\\app.sqlite");
		expect(got[0]?.subPath).toBe("users");
	});
});

describe("lastIndex of the module-level /gi regex does not leak across calls", () => {
	it("parses a short path after a long one and still finds the extension", () => {
		expect(parseSqlitePathCandidates("a/very/long/dir/app.sqlite:users?limit=1")).toHaveLength(1);
		expect(parseSqlitePathCandidates("b.db")).toEqual([
			{ sqlitePath: "b.db", subPath: "", queryString: "" },
		]);
		expect(parseSqlitePathCandidates("no-extension")).toEqual([]);
	});
});
