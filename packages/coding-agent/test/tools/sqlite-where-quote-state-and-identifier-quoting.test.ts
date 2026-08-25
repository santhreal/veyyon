/**
 * Structured SQLite `where=` is a quote-state scanner, not a SQL parser.
 *
 * WHY THIS SUITE EXISTS. `queryRows` interpolates the clause between `WHERE`
 * and a bound `LIMIT ? OFFSET ?`. The scanner is the only thing that keeps
 * `LIMIT`/`UNION`/`;`/`--`/`ATTACH` from escaping that pagination. The
 * existing sqlite.test.ts pins LIMIT-after-predicate and `; DROP`. It does
 * not pin the scanner's quote machine against SQLite's other identifier
 * quotes (backticks, brackets), doubled-quote escapes, keywords that are
 * legal column names, or control syntax hidden after a closed string.
 *
 * A false negative writes a live `UNION SELECT` onto a bound listing. A
 * false positive makes a legal predicate unusable (`name = 'limit'` is
 * fine; so is `"union" = 1` as an identifier). Stay red when the scanner
 * treats a quoted identifier as a keyword, or lets a keyword through
 * because it sat in backticks.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
	getRowByKey,
	parseSqlitePathCandidates,
	parseSqliteSelector,
	queryRows,
} from "@veyyon/coding-agent/tools/sqlite-reader";

function where(clause: string): ReturnType<typeof parseSqliteSelector> {
	return parseSqliteSelector("users", `where=${encodeURIComponent(clause)}&limit=2&offset=0`);
}

describe("where= string literals are not control syntax", () => {
	it("allows a predicate whose string value is the word LIMIT", () => {
		expect(where("status = 'LIMIT'")).toMatchObject({
			kind: "query",
			where: "status = 'LIMIT'",
		});
	});

	it("allows a predicate whose string value is UNION SELECT 1", () => {
		expect(where("note = 'UNION SELECT 1'")).toMatchObject({
			kind: "query",
			where: "note = 'UNION SELECT 1'",
		});
	});

	it("allows a doubled single-quote inside a string (SQL escaped apostrophe)", () => {
		expect(where("name = 'O''Brien'")).toMatchObject({
			kind: "query",
			where: "name = 'O''Brien'",
		});
	});

	it("still rejects LIMIT after the string closes", () => {
		expect(() => where("name = 'ok' LIMIT 999")).toThrow(/LIMIT\/OFFSET\/UNION/i);
	});

	it("still rejects a terminator after the string closes", () => {
		expect(() => where("name = 'ok'; DROP TABLE users")).toThrow(/comments or statement terminators/i);
	});

	it("still rejects a line comment after the string closes", () => {
		expect(() => where("name = 'ok' --")).toThrow(/comments or statement terminators/i);
	});

	it("still rejects a block comment after the string closes", () => {
		expect(() => where("name = 'ok' /*")).toThrow(/comments or statement terminators/i);
	});

	it("rejects a block-comment closer even with no opener (the scanner treats */ as a comment token)", () => {
		expect(() => where("name = 'ok' */")).toThrow(/comments or statement terminators/i);
	});
});

describe("where= double-quoted identifiers vs keywords", () => {
	/**
	 * SQLite identifiers may be double-quoted. `"union"` is a column name, not
	 * UNION. The scanner currently tracks double quotes as strings, so this
	 * MUST parse: treating the quoted ident as a keyword would make a legal
	 * schema unqueryable.
	 */
	it("allows a double-quoted identifier that spells a forbidden keyword", () => {
		expect(where('"union" IS NOT NULL')).toMatchObject({
			kind: "query",
			where: '"union" IS NOT NULL',
		});
	});

	it("allows a doubled double-quote inside an identifier", () => {
		expect(where('"weird""name" = 1')).toMatchObject({
			kind: "query",
			where: '"weird""name" = 1',
		});
	});

	it("still rejects UNION after a closed identifier", () => {
		expect(() => where('"id" = 1 UNION SELECT 1')).toThrow(/LIMIT\/OFFSET\/UNION/i);
	});
});

describe("where= backtick and bracket identifiers (SQLite also accepts these)", () => {
	/**
	 * SQLite accepts `ident` and [ident] as identifier quotes. The scanner
	 * only tracks ' and ". A backtick-quoted `union` therefore tokenizes as
	 * the bare word UNION and is refused — a real operator with a column
	 * named union cannot use the structured helper and is pushed onto raw
	 * `?q=`. Pin the refusal as a defect until the scanner knows these
	 * quotes; do not document it as the intended grammar.
	 */
	it("does not treat a backtick-quoted keyword as UNION/LIMIT control syntax", () => {
		expect(() => where("`union` IS NOT NULL")).not.toThrow();
		expect(where("`union` IS NOT NULL")).toMatchObject({
			kind: "query",
			where: "`union` IS NOT NULL",
		});
	});

	it("does not treat a bracket-quoted keyword as UNION/LIMIT control syntax", () => {
		expect(() => where("[limit] IS NOT NULL")).not.toThrow();
		expect(where("[limit] IS NOT NULL")).toMatchObject({
			kind: "query",
			where: "[limit] IS NOT NULL",
		});
	});
});

describe("where= forbidden keywords are case-insensitive and bounded", () => {
	it("rejects UnIoN as the same control word as UNION", () => {
		expect(() => where("1=1 UnIoN SELECT 1")).toThrow(/LIMIT\/OFFSET\/UNION/i);
	});

	it("rejects INTERSECT and EXCEPT, not only UNION", () => {
		expect(() => where("1=1 INTERSECT SELECT 1")).toThrow(/LIMIT\/OFFSET\/UNION/i);
		expect(() => where("1=1 EXCEPT SELECT 1")).toThrow(/LIMIT\/OFFSET\/UNION/i);
	});

	it("rejects ATTACH and DETACH and PRAGMA as structured-path escapes", () => {
		expect(() => where("1=1 ATTACH 'x.db' AS extra")).toThrow(/LIMIT\/OFFSET\/UNION/i);
		expect(() => where("1=1 DETACH extra")).toThrow(/LIMIT\/OFFSET\/UNION/i);
		expect(() => where("1=1 PRAGMA cache_size")).toThrow(/LIMIT\/OFFSET\/UNION/i);
	});

	it("does not treat tokenizer as LIMIT (trailing ident chars must not match)", () => {
		expect(where("tokenizer = 1")).toMatchObject({ kind: "query", where: "tokenizer = 1" });
	});

	it("does not treat limited as LIMIT", () => {
		expect(where("limited = 1")).toMatchObject({ kind: "query", where: "limited = 1" });
	});

	it("does not treat reunion as UNION", () => {
		expect(where("reunion = 1")).toMatchObject({ kind: "query", where: "reunion = 1" });
	});

	it("rejects OFFSET as well as LIMIT", () => {
		expect(() => where("1=1 OFFSET 0")).toThrow(/LIMIT\/OFFSET\/UNION/i);
	});
});

describe("parseSqliteSelector refuses mixed raw SQL and structured selectors", () => {
	it("refuses q= together with a table subpath", () => {
		expect(() => parseSqliteSelector("users", "q=SELECT 1")).toThrow(/cannot be combined/i);
	});

	it("refuses q= together with limit", () => {
		expect(() => parseSqliteSelector("", "q=SELECT 1&limit=2")).toThrow(/cannot be combined/i);
	});

	it("refuses an empty q=", () => {
		expect(() => parseSqliteSelector("", "q=")).toThrow(/cannot be empty/i);
		expect(() => parseSqliteSelector("", "q=%20")).toThrow(/cannot be empty/i);
	});

	it("refuses query params with no table and no q=", () => {
		expect(() => parseSqliteSelector("", "limit=2")).toThrow(/require a table selector/i);
	});

	it("refuses an unknown query key on a table selector", () => {
		expect(() => parseSqliteSelector("users", "foo=1")).toThrow(/Unsupported SQLite query parameter 'foo'/);
	});

	it("refuses row lookup combined with query params", () => {
		expect(() => parseSqliteSelector("users:1", "limit=2")).toThrow(/cannot be combined with query parameters/i);
	});

	it("treats users: (empty key) as schema, not a row lookup", () => {
		expect(parseSqliteSelector("users:", "")).toMatchObject({ kind: "schema", table: "users" });
	});

	it("strips extra leading colons on the table name", () => {
		expect(parseSqliteSelector(":::users", "")).toMatchObject({ kind: "schema", table: "users" });
	});
});

describe("parseSqlitePathCandidates only splits on a real database extension boundary", () => {
	it("does not treat file.db.bak as a database (the extension is .bak)", () => {
		expect(parseSqlitePathCandidates("file.db.bak")).toEqual([]);
	});

	it("does not treat file.database as a .db file", () => {
		expect(parseSqlitePathCandidates("file.database")).toEqual([]);
	});

	it("does not treat notes.sqlite3-journal as a database", () => {
		expect(parseSqlitePathCandidates("notes.sqlite3-journal")).toEqual([]);
	});

	it("splits at .sqlite before :table", () => {
		expect(parseSqlitePathCandidates("/vault/notes.sqlite:users")).toEqual([
			{ sqlitePath: "/vault/notes.sqlite", subPath: "users", queryString: "" },
		]);
	});

	it("splits at .sqlite3 before ?q=", () => {
		const got = parseSqlitePathCandidates("/vault/notes.sqlite3?q=SELECT%201");
		expect(got).toEqual([
			{ sqlitePath: "/vault/notes.sqlite3", subPath: "", queryString: "q=SELECT%201" },
		]);
	});

	it("splits at .db3 the same way as .db", () => {
		expect(parseSqlitePathCandidates("x.db3:t")).toEqual([{ sqlitePath: "x.db3", subPath: "t", queryString: "" }]);
	});

	it("when a path contains both .db and .sqlite, prefers the longer (rightmost extension) candidate first", () => {
		const got = parseSqlitePathCandidates("/tmp/foo.db.dir/bar.sqlite:users");
		expect(got[0]).toMatchObject({ sqlitePath: "/tmp/foo.db.dir/bar.sqlite", subPath: "users" });
	});

	it("normalizes backslashes only for matching, and returns the original slice as sqlitePath", () => {
		const got = parseSqlitePathCandidates("C:\\vault\\notes.sqlite:users");
		expect(got).toHaveLength(1);
		expect(got[0]?.sqlitePath).toBe("C:\\vault\\notes.sqlite");
		expect(got[0]?.subPath).toBe("users");
	});
});

describe("quoted table names and integer keys that do not fit in Number", () => {
	it("looks up a table whose name contains a double quote via identifier quoting", () => {
		const db = new Database(":memory:");
		db.run('CREATE TABLE "we""ird" (id INTEGER PRIMARY KEY, n TEXT)');
		db.run('INSERT INTO "we""ird" (id, n) VALUES (1, \'ok\')');
		const row = getRowByKey(db, 'we"ird', { column: "id", type: "INTEGER" }, "1");
		expect(row).toEqual({ id: 1, n: "ok" });
	});

	it("binds a primary key larger than Number.MAX_SAFE_INTEGER as BigInt rather than rounding", () => {
		const db = new Database(":memory:");
		db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT)");
		const key = "9007199254740993"; // MAX_SAFE_INTEGER + 2
		db.run("INSERT INTO t (id, n) VALUES (?, ?)", BigInt(key), "wide");
		const row = getRowByKey(db, "t", { column: "id", type: "INTEGER" }, key);
		expect(row?.n).toBe("wide");
		expect(String(row?.id)).toBe(key);
	});

	it("rejects a non-integer key against an INTEGER primary key before touching the statement", () => {
		const db = new Database(":memory:");
		db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT)");
		expect(() => getRowByKey(db, "t", { column: "id", type: "INTEGER" }, "1e2")).toThrow(/must be an integer/i);
		expect(() => getRowByKey(db, "t", { column: "id", type: "INTEGER" }, "1.5")).toThrow(/must be an integer/i);
		expect(() => getRowByKey(db, "t", { column: "id", type: "INTEGER" }, "0x10")).toThrow(/must be an integer/i);
	});

	it("interpolating a quoted where= that names a missing column fails at SQLite, not by silently rewriting LIMIT", () => {
		const db = new Database(":memory:");
		db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
		db.run("INSERT INTO users (id, name) VALUES (1, 'a')");
		expect(() => queryRows(db, "users", { limit: 2, offset: 0, where: "nope = 1" })).toThrow();
	});
});
