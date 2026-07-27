import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { escapeLike, SQLITE_NOW_EPOCH, sqlPlaceholders, tableExists } from "../src/sqlite";

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

/**
 * The SQL expression for "now, in whole seconds since the epoch", and the one place it is written.
 *
 * These are behavioural rather than textual assertions on purpose. The expression is interpolated into SQL
 * strings, so what matters is what SQLite computes from it: seconds, an INTEGER, and one value per statement.
 * Three modules across two packages each carried their own copy of this exact string, each writing a column
 * some other module reads (`auth_credentials.updated_at`, `model_perf.updated_at`, the history tables). A
 * copy edited to milliseconds or to a Julian day would put values a thousand times out of range into one
 * table while every reader kept interpreting them as seconds, and nothing would throw.
 */
describe("SQLITE_NOW_EPOCH", () => {
	/**
	 * The unit. A millisecond value would be ~1000x larger and would silently pass any test that only checked
	 * the column was a number, which is why this brackets it against the JavaScript clock.
	 */
	it("evaluates to the current time in whole seconds, not milliseconds", () => {
		db = new Database(":memory:");
		const before = Math.floor(Date.now() / 1000);
		const value = db.query(`SELECT ${SQLITE_NOW_EPOCH} AS now`).get() as { now: number };
		const after = Math.floor(Date.now() / 1000);
		expect(value.now).toBeGreaterThanOrEqual(before - 1);
		expect(value.now).toBeLessThanOrEqual(after + 1);
	});

	/**
	 * An INTEGER, not a float and not the TEXT that `strftime` returns on its own. A TEXT timestamp compares
	 * lexicographically, so `"999999999" > "1000000000"` and every ordering and expiry window built on the
	 * column would be wrong in a way that still returns rows.
	 */
	it("yields an integer rather than the text strftime returns unwrapped", () => {
		db = new Database(":memory:");
		const wrapped = db.query(`SELECT typeof(${SQLITE_NOW_EPOCH}) AS kind`).get() as { kind: string };
		expect(wrapped.kind).toBe("integer");
		const bare = db.query("SELECT typeof(strftime('%s','now')) AS kind").get() as { kind: string };
		expect(bare.kind).toBe("text");
	});

	/**
	 * Usable as a column DEFAULT, which is how three of the schemas consume it. A DEFAULT is parsed when the
	 * table is created, so an expression SQLite rejects there fails at schema creation rather than at insert.
	 */
	it("is accepted as a column DEFAULT and stamps a row inserted without one", () => {
		db = new Database(":memory:");
		db.run(`CREATE TABLE t (id INTEGER PRIMARY KEY, updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}))`);
		db.run("INSERT INTO t (id) VALUES (1)");
		const row = db.query("SELECT updated_at FROM t WHERE id = 1").get() as { updated_at: number };
		expect(Number.isInteger(row.updated_at)).toBeTrue();
		expect(row.updated_at).toBeGreaterThan(1_700_000_000);
	});

	/**
	 * Two uses in one statement agree. The upsert in `agent-storage.ts` interpolates this twice, once for the
	 * insert and once for the conflict update, and a row whose `created_at` and `updated_at` disagreed by a
	 * second would look edited the moment it was created.
	 */
	it("gives one value to every use within a single statement", () => {
		db = new Database(":memory:");
		const row = db.query(`SELECT ${SQLITE_NOW_EPOCH} AS a, ${SQLITE_NOW_EPOCH} AS b`).get() as {
			a: number;
			b: number;
		};
		expect(row.a).toBe(row.b);
	});

	/**
	 * The ratchet. This is the reason the constant moved into `@veyyon/utils`: `@veyyon/ai` and
	 * `@veyyon/coding-agent` both write these columns, so neither package can own the expression, and before
	 * the move each simply kept its own copy.
	 */
	it("is declared here and in no other module across the packages that use it", async () => {
		const packagesDir = path.resolve(import.meta.dir, "../..");
		const files = [...new Bun.Glob("{utils,ai,coding-agent}/src/**/*.ts").scanSync(packagesDir)]
			.map(file => file.split(path.sep).join("/"))
			.sort();
		expect(files.length).toBeGreaterThan(1_000);
		const declarers: string[] = [];
		for (const file of files) {
			const text = await Bun.file(path.join(packagesDir, file)).text();
			if (text.includes(`= "${SQLITE_NOW_EPOCH}"`)) declarers.push(file);
		}
		expect(declarers).toEqual(["utils/src/sqlite.ts"]);
	});

	/**
	 * And the three modules that actually build SQL take it from here, so the ratchet is not passing on an
	 * empty set.
	 *
	 * `ai/src/auth-storage.ts` is deliberately NOT in this list even though it once held the declaration. It
	 * is the OAuth module now, the sqlite store having moved to `auth-storage-sqlite.ts`, and
	 * `packages/ai/test/credential-store-is-not-the-oauth-machinery.test.ts` forbids it from importing
	 * `@veyyon/utils/sqlite` at all: an import there would mean a second place was writing rows. Repointing
	 * it during the unification is what surfaced that its import had been dead since the split, and both
	 * gates now agree the module has no business with SQL.
	 */
	it("is imported by every module that builds SQL with it", async () => {
		const packagesDir = path.resolve(import.meta.dir, "../..");
		for (const file of [
			"ai/src/auth-storage-sqlite.ts",
			"coding-agent/src/session/agent-storage.ts",
			"coding-agent/src/session/history-storage.ts",
		]) {
			const text = await Bun.file(path.join(packagesDir, file)).text();
			expect(text).toContain("SQLITE_NOW_EPOCH");
			expect(text).toContain('from "@veyyon/utils/sqlite"');
		}
	});
});
