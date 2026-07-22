/**
 * relocate no-op when source missing; relocate moves head.
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore } from "@veyyon/hashline";

describe("InMemorySnapshotStore relocate edges", () => {
	it("no-op missing source", () => {
		const store = new InMemorySnapshotStore();
		store.record("keep.ts", "k");
		store.relocate("missing.ts", "dest.ts");
		expect(store.head("keep.ts")!.text).toBe("k");
		expect(store.head("dest.ts")).toBeNull();
	});

	it("moves head and byHash", () => {
		const store = new InMemorySnapshotStore();
		const h = store.record("old.ts", "body");
		store.relocate("old.ts", "new.ts");
		expect(store.head("old.ts")).toBeNull();
		expect(store.head("new.ts")!.text).toBe("body");
		expect(store.byHash("new.ts", h)!.path).toBe("new.ts");
	});
});
