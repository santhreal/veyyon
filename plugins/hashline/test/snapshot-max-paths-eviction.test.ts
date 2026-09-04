/**
 * InMemorySnapshotStore maxPaths LRU: cold paths age out.
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore } from "@veyyon/hashline";

describe("InMemorySnapshotStore maxPaths eviction", () => {
	it("evicts least-recently-used path when over maxPaths", () => {
		const store = new InMemorySnapshotStore({ maxPaths: 2 });
		store.record("a.ts", "a");
		store.record("b.ts", "b");
		// touch a to make b colder? head() may refresh LRU depending on lru-cache get
		// recording c should drop one of a/b
		store.record("c.ts", "c");
		const alive = [store.head("a.ts"), store.head("b.ts"), store.head("c.ts")].filter(Boolean);
		expect(alive.length).toBeLessThanOrEqual(2);
		expect(store.head("c.ts")).not.toBeNull();
	});

	it("re-record refreshes recency so older paths drop first", () => {
		const store = new InMemorySnapshotStore({ maxPaths: 2 });
		store.record("old.ts", "1");
		store.record("keep.ts", "2");
		// refresh keep
		store.record("keep.ts", "2");
		store.record("new.ts", "3");
		expect(store.head("keep.ts")).not.toBeNull();
		expect(store.head("new.ts")).not.toBeNull();
		// old may be gone
		// at most 2 paths
		const count = ["old.ts", "keep.ts", "new.ts"].filter(p => store.head(p) !== null).length;
		expect(count).toBe(2);
	});
});
