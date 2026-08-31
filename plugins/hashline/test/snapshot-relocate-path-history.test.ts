/**
 * SnapshotStore.relocate moves history so tags minted at source remain valid
 * at destination.
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore } from "@veyyon/hashline";

describe("SnapshotStore.relocate path history", () => {
	it("moves head and byHash to new path", () => {
		const store = new InMemorySnapshotStore();
		const h = store.record("old.ts", "body\n");
		store.relocate("old.ts", "new.ts");
		expect(store.head("old.ts")).toBeNull();
		expect(store.head("new.ts")?.text).toBe("body\n");
		expect(store.byHash("new.ts", h)?.text).toBe("body\n");
		expect(store.byHash("old.ts", h)).toBeNull();
	});

	it("relocate empty source is no-op", () => {
		const store = new InMemorySnapshotStore();
		store.record("keep.ts", "x\n");
		store.relocate("missing.ts", "dest.ts");
		expect(store.head("keep.ts")?.text).toBe("x\n");
		expect(store.head("dest.ts")).toBeNull();
	});

	it("relocate preserves multi-version history", () => {
		const store = new InMemorySnapshotStore();
		const h1 = store.record("a.ts", "v1\n");
		const h2 = store.record("a.ts", "v2\n");
		store.relocate("a.ts", "b.ts");
		expect(store.byHash("b.ts", h1)?.text).toBe("v1\n");
		expect(store.byHash("b.ts", h2)?.text).toBe("v2\n");
		expect(store.head("b.ts")?.hash).toBe(h2);
	});
});
