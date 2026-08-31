/**
 * invalidate one path does not affect another.
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore } from "@veyyon/hashline";

describe("InMemorySnapshotStore invalidate isolation", () => {
	it("invalidate a leaves b", () => {
		const store = new InMemorySnapshotStore();
		store.record("a.ts", "a");
		store.record("b.ts", "b");
		store.invalidate("a.ts");
		expect(store.head("a.ts")).toBeNull();
		expect(store.head("b.ts")!.text).toBe("b");
	});

	it("invalidate missing is no-op", () => {
		const store = new InMemorySnapshotStore();
		store.record("a.ts", "a");
		store.invalidate("missing.ts");
		expect(store.head("a.ts")!.text).toBe("a");
	});

	it("invalidate then re-record works", () => {
		const store = new InMemorySnapshotStore();
		store.record("a.ts", "old");
		store.invalidate("a.ts");
		const h = store.record("a.ts", "new");
		expect(store.byHash("a.ts", h)!.text).toBe("new");
	});
});
