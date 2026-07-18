import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { closeQuietly, openDatabase, transaction, transactionAsync } from "../src/db";

function table(db: Database): void {
	db.exec("CREATE TABLE t (v TEXT)");
}

function count(db: Database): number {
	return (db.query("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n;
}

describe("openDatabase", () => {
	it("opens :memory: with pragmas applied but no WAL", () => {
		const db = openDatabase(":memory:");
		expect((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
		expect((db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5000);
		expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("memory");
		db.close();
	});

	it("skips pragmas when pragmas: false", () => {
		const db = openDatabase(":memory:", { pragmas: false });
		expect((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(0);
		db.close();
	});
});

describe("transaction", () => {
	it("commits on success and returns the callback result", () => {
		const db = openDatabase(":memory:");
		table(db);
		const result = transaction(db, () => {
			db.run("INSERT INTO t VALUES ('a')");
			return "done";
		});
		expect(result).toBe("done");
		expect(count(db)).toBe(1);
		db.close();
	});

	it("rolls back every write when the callback throws", () => {
		const db = openDatabase(":memory:");
		table(db);
		expect(() =>
			transaction(db, () => {
				db.run("INSERT INTO t VALUES ('a')");
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(count(db)).toBe(0);
		db.close();
	});

	it("flattens nested transactions into the outer one (no savepoint commit mid-way)", () => {
		const db = openDatabase(":memory:");
		table(db);
		expect(() =>
			transaction(db, () => {
				db.run("INSERT INTO t VALUES ('outer')");
				transaction(db, () => {
					db.run("INSERT INTO t VALUES ('inner')");
				});
				throw new Error("late failure");
			}),
		).toThrow("late failure");
		// The inner "commit" must not have persisted anything.
		expect(count(db)).toBe(0);
		db.close();
	});

	it("recovers for a fresh transaction after a failed one", () => {
		const db = openDatabase(":memory:");
		table(db);
		expect(() =>
			transaction(db, () => {
				throw new Error("first");
			}),
		).toThrow("first");
		transaction(db, () => db.run("INSERT INTO t VALUES ('b')"));
		expect(count(db)).toBe(1);
		db.close();
	});
});

describe("transactionAsync", () => {
	it("commits awaited work and rolls back on rejection", async () => {
		const db = openDatabase(":memory:");
		table(db);
		await transactionAsync(db, async () => {
			db.run("INSERT INTO t VALUES ('a')");
			await Promise.resolve();
			db.run("INSERT INTO t VALUES ('b')");
		});
		expect(count(db)).toBe(2);
		await expect(
			transactionAsync(db, async () => {
				db.run("INSERT INTO t VALUES ('c')");
				throw new Error("async boom");
			}),
		).rejects.toThrow("async boom");
		expect(count(db)).toBe(2);
		db.close();
	});

	it("nests inside an outer async transaction sharing its fate", async () => {
		const db = openDatabase(":memory:");
		table(db);
		await expect(
			transactionAsync(db, async () => {
				db.run("INSERT INTO t VALUES ('outer')");
				await transactionAsync(db, async () => {
					db.run("INSERT INTO t VALUES ('inner')");
				});
				throw new Error("late");
			}),
		).rejects.toThrow("late");
		expect(count(db)).toBe(0);
		db.close();
	});
});

describe("closeQuietly", () => {
	it("tolerates null, undefined, and double-close", () => {
		closeQuietly(null);
		closeQuietly(undefined);
		const db = new Database(":memory:");
		db.close();
		closeQuietly(db); // already closed — must not throw
	});
});
