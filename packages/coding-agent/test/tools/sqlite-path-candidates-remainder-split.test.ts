/**
 * parseSqlitePathCandidates is a global /gi regex over the file path.
 * The extension must sit at `:`, `?`, or end-of-string. A `.db` in the
 * middle of a filename (`notes.db.bak`) is not a database. Two extensions
 * in one path (`dir.db/app.sqlite:users`) produce two candidates, longest
 * sqlitePath first, because the reader tries the longest existing file.
 *
 * splitSqliteRemainder strips leading colons of the subpath and splits on
 * the first `?`. A `?` inside a where= clause is query-string, not a second
 * database. Backslashes are normalized for matching but sqlitePath is sliced
 * from the original (Windows paths keep their separators).
 *
 * The /gi lastIndex must not leak across calls: a completed scan ends on
 * null, which resets lastIndex. Pin two consecutive parses of different
 * strings so a future early-return cannot leave lastIndex mid-path.
 */
import { describe, expect, it } from "bun:test";
import { parseSqlitePathCandidates } from "@veyyon/coding-agent/tools/sqlite-reader";

describe("extension must sit at a selector boundary, not mid-name", () => {
	it("does not treat notes.db.bak as a sqlite path", () => {
		expect(parseSqlitePathCandidates("notes.db.bak")).toEqual([]);
	});

	it("does treat notes.db as a sqlite path with empty selector", () => {
		expect(parseSqlitePathCandidates("notes.db")).toEqual([
			{ sqlitePath: "notes.db", subPath: "", queryString: "" },
		]);
	});

	it("accepts .sqlite3 and .db3 as well as .sqlite and .db", () => {
		expect(parseSqlitePathCandidates("a.sqlite3:users")).toEqual([
			{ sqlitePath: "a.sqlite3", subPath: "users", queryString: "" },
		]);
		expect(parseSqlitePathCandidates("a.db3:users")).toEqual([
			{ sqlitePath: "a.db3", subPath: "users", queryString: "" },
		]);
	});

	it("does not match .sqliteN where N is a fourth digit", () => {
		expect(parseSqlitePathCandidates("a.sqlite4")).toEqual([]);
	});
});

describe("two extensions in one path produce two candidates, longest first", () => {
	it("does not treat `.db/` as a database — the extension is not at `:`, `?`, or EOS", () => {
		const got = parseSqlitePathCandidates("dir.db/app.sqlite:users");
		expect(got).toEqual([
			{ sqlitePath: "dir.db/app.sqlite", subPath: "users", queryString: "" },
		]);
	});

	it("does emit two candidates when both extensions sit on a selector boundary", () => {
		const got = parseSqlitePathCandidates("dir.db:ignored/app.sqlite:users");
		expect(got.map(c => c.sqlitePath)).toEqual(["dir.db:ignored/app.sqlite", "dir.db"]);
		expect(got[1]).toEqual({ sqlitePath: "dir.db", subPath: "ignored/app.sqlite:users", queryString: "" });
	});
});

describe("remainder split: first `?` starts the query string, colons are stripped from the table", () => {
	it("parses app.sqlite:users?where=name='?'&limit=2 without treating the quoted ? as a second selector", () => {
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

	it("treats app.sqlite?q=SELECT+1 as a raw-query remainder with empty table", () => {
		expect(parseSqlitePathCandidates("app.sqlite?q=SELECT+1")).toEqual([
			{ sqlitePath: "app.sqlite", subPath: "", queryString: "q=SELECT+1" },
		]);
	});
});

describe("backslash matching uses a normalized copy; sqlitePath is sliced from the original", () => {
	it("keeps Windows separators on sqlitePath when the input used them", () => {
		const got = parseSqlitePathCandidates("C:\\\\data\\\\app.sqlite:users");
		expect(got).toHaveLength(1);
		expect(got[0]?.sqlitePath).toBe("C:\\\\data\\\\app.sqlite");
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
		expect(parseSqlitePathCandidates("c.sqlite3")).toEqual([
			{ sqlitePath: "c.sqlite3", subPath: "", queryString: "" },
		]);
	});
});
