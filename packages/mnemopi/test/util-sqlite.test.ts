import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { tableExists } from "../src/util/sqlite";

describe("tableExists", () => {
	it("sees regular AND virtual tables — shmr's old type='table' copy missed FTS/vec tables", () => {
		const db = new Database(":memory:");
		db.run("CREATE TABLE plain (id INTEGER)");
		db.run("CREATE VIRTUAL TABLE search USING fts5(content)");
		expect(tableExists(db, "plain")).toBe(true);
		expect(tableExists(db, "search")).toBe(true);
		expect(tableExists(db, "missing")).toBe(false);
		db.close();
	});

	it("propagates errors from a closed handle instead of reporting the table as missing", () => {
		const db = new Database(":memory:");
		db.run("CREATE TABLE plain (id INTEGER)");
		db.close();
		expect(() => tableExists(db, "plain")).toThrow();
	});
});
