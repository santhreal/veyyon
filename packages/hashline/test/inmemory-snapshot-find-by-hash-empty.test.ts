/**
 * findByHash empty store and after clear.
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, computeFileHash } from "@veyyon/hashline";

describe("InMemorySnapshotStore findByHash edge", () => {
	it("empty store returns []", () => {
		expect(new InMemorySnapshotStore().findByHash("AAAA")).toEqual([]);
	});

	it("after clear returns []", () => {
		const store = new InMemorySnapshotStore();
		const h = store.record("a.ts", "x");
		store.clear();
		expect(store.findByHash(h)).toEqual([]);
	});

	it("matches only recorded hash", () => {
		const store = new InMemorySnapshotStore();
		const text = "unique-body-xyz";
		const h = store.record("a.ts", text);
		expect(store.findByHash(h)).toHaveLength(1);
		expect(store.findByHash(h)[0]!.text).toBe(text);
		expect(store.findByHash(computeFileHash("other"))).toEqual([]);
	});
});
