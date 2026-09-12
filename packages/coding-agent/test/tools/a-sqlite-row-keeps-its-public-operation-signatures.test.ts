import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import {
	deleteRowByKey,
	deleteRowByRowId,
	getRowByKey,
	getRowByRowId,
	updateRowByKey,
	updateRowByRowId,
} from "@veyyon/coding-agent/tools/core/sqlite-reader";

/**
 * WHY: Combining primary-key and ROWID operations must preserve the exported
 * signatures, including an omitted primary-key type. Tool-level tests cannot
 * detect removed exports when their callers change together. This suite covers
 * the public CRUD boundary; selector parsing remains in sqlite.test.ts.
 */
it.each(["typed key", "untyped key", "rowid"] as const)("preserves public row operations for %s", kind => {
	const db = new Database(":memory:");
	try {
		db.run("CREATE TABLE notes (slug TEXT PRIMARY KEY, body TEXT NOT NULL)");
		db.run("INSERT INTO notes VALUES ('first', 'original'), ('second', 'untouched')");
		const pk = kind === "typed key" ? { column: "slug", type: "TEXT" } : { column: "slug" };
		const read = () => (kind === "rowid" ? getRowByRowId(db, "notes", "1") : getRowByKey(db, "notes", pk, "first"));
		const update = () =>
			kind === "rowid"
				? updateRowByRowId(db, "notes", "1", { body: "updated" })
				: updateRowByKey(db, "notes", pk, "first", { body: "updated" });
		const remove = () =>
			kind === "rowid" ? deleteRowByRowId(db, "notes", "1") : deleteRowByKey(db, "notes", pk, "first");
		expect(read()).toEqual({ slug: "first", body: "original" });
		expect(update()).toBe(1);
		expect(read()).toEqual({ slug: "first", body: "updated" });
		expect(remove()).toBe(1);
		expect(read()).toBeNull();
		expect(update()).toBe(0);
		expect(remove()).toBe(0);
		expect(db.query("SELECT slug, body FROM notes").all()).toEqual([{ slug: "second", body: "untouched" }]);
	} finally {
		db.close();
	}
});
