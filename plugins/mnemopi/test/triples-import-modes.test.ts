import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { TripleStore } from "../src/core/triples";

function memoryStore(): TripleStore {
	return new TripleStore(new Database(":memory:"));
}

describe("TripleStore.importAll collision modes", () => {
	it("force-overwrites colliding ids with the imported content", () => {
		const store = memoryStore();
		const id = store.add("alice", "role", "engineer");
		const stats = store.importAll(
			[{ id, subject: "alice", predicate: "role", object: "manager", valid_from: "2026-01-01" }],
			true,
		);
		expect(stats).toEqual({ inserted: 0, skipped: 0, overwritten: 1, imported_renumbered: 0 });
		const rows = store.exportAll();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe(id);
		expect(rows[0]?.object).toBe("manager");
		expect(rows[0]?.source).toBe("imported");
	});

	it("renumbers divergent-content collisions instead of dropping them when not forced", () => {
		const store = memoryStore();
		const id = store.add("alice", "role", "engineer");
		const stats = store.importAll([
			{ id, subject: "bob", predicate: "role", object: "designer", valid_from: "2026-01-01" },
		]);
		expect(stats).toEqual({ inserted: 0, skipped: 0, overwritten: 0, imported_renumbered: 1 });
		const rows = store.exportAll();
		expect(rows).toHaveLength(2);
		expect(rows.map(r => r.subject).sort()).toEqual(["alice", "bob"]);
		expect(rows[1]?.id).toBeGreaterThan(id);
	});

	it("inserts id-less rows and keeps explicit non-colliding ids", () => {
		const store = memoryStore();
		const stats = store.importAll([
			{ id: 42, subject: "a", predicate: "p", object: "o", valid_from: "2026-01-01" },
			{ subject: "b", predicate: "p", object: "o", valid_from: "2026-01-01" },
		]);
		expect(stats).toEqual({ inserted: 2, skipped: 0, overwritten: 0, imported_renumbered: 0 });
		const rows = store.exportAll();
		expect(rows.find(r => r.subject === "a")?.id).toBe(42);
		expect(rows.find(r => r.subject === "b")?.id).not.toBe(42);
	});

	it("rejects duplicate ids within one imported batch before writing anything", () => {
		const store = memoryStore();
		expect(() =>
			store.importAll([
				{ id: 1, subject: "a", predicate: "p", object: "o" },
				{ id: 1, subject: "b", predicate: "p", object: "o" },
			]),
		).toThrow(/duplicate id 1/);
		expect(store.exportAll()).toHaveLength(0);
	});

	it("rolls back the whole batch when a row violates NOT NULL", () => {
		const store = memoryStore();
		expect(() =>
			store.importAll([
				{ subject: "good", predicate: "p", object: "o", valid_from: "2026-01-01" },
				{ subject: "bad", predicate: "p", object: null as unknown as string, valid_from: "2026-01-01" },
			]),
		).toThrow();
		expect(store.exportAll()).toHaveLength(0);
	});
});

describe("TripleStore query surfaces", () => {
	it("queryByPredicate narrows by object and subject", () => {
		const store = memoryStore();
		store.add("alice", "likes", "rust");
		store.add("bob", "likes", "rust");
		store.add("alice", "likes", "zig");
		expect(store.queryByPredicate("likes")).toHaveLength(3);
		expect(
			store
				.queryByPredicate("likes", "rust")
				.map(r => r.subject)
				.sort(),
		).toEqual(["alice", "bob"]);
		expect(
			store
				.queryByPredicate("likes", null, "alice")
				.map(r => r.object)
				.sort(),
		).toEqual(["rust", "zig"]);
		expect(store.queryByPredicate("likes", "rust", "bob")).toHaveLength(1);
	});

	it("getDistinctObjects returns sorted unique objects for a predicate", () => {
		const store = memoryStore();
		store.add("alice", "likes", "zig");
		store.add("bob", "likes", "rust");
		store.add("carol", "likes", "rust");
		expect(store.getDistinctObjects("likes")).toEqual(["rust", "zig"]);
		expect(store.getDistinctObjects("dislikes")).toEqual([]);
	});

	it("accepts an options object with snake_case as_of", () => {
		const store = memoryStore();
		store.add("alice", "role", "engineer", "2026-01-01");
		store.add("alice", "role", "manager", "2026-03-01");
		const asOfEarly = store.query({ subject: "alice", as_of: "2026-02-01" });
		expect(asOfEarly).toHaveLength(1);
		expect(asOfEarly[0]?.object).toBe("engineer");
		const current = store.query({ subject: "alice" });
		expect(current).toHaveLength(1);
		expect(current[0]?.object).toBe("manager");
	});

	it("string options shorthand sets valid_from with inferred source", () => {
		const store = memoryStore();
		store.add("alice", "role", "engineer", "2026-01-01");
		const row = store.exportAll()[0];
		expect(row?.valid_from).toBe("2026-01-01");
		expect(row?.source).toBe("inferred");
		expect(row?.confidence).toBe(1.0);
	});
});
