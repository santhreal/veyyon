/**
 * Snapshot seenLines union across partial reads of identical content.
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore } from "@veyyon/hashline";

describe("Snapshot seenLines union matrix", () => {
	it("unions disjoint ranges across re-records of same text", () => {
		const store = new InMemorySnapshotStore();
		const text = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join("\n");
		const h = store.record("f.ts", text, [1, 2, 3]);
		store.record("f.ts", text, [10, 11]);
		store.recordSeenLines("f.ts", h, [20]);
		const seen = [...store.byHash("f.ts", h)!.seenLines!].sort((a, b) => a - b);
		expect(seen).toEqual([1, 2, 3, 10, 11, 20]);
	});

	it("identical re-record with no seenLines keeps previous set", () => {
		const store = new InMemorySnapshotStore();
		const h = store.record("f.ts", "body", [1, 2]);
		store.record("f.ts", "body");
		expect([...store.byHash("f.ts", h)!.seenLines!].sort((a, b) => a - b)).toEqual([1, 2]);
	});

	it("different content versions have independent seenLines", () => {
		const store = new InMemorySnapshotStore();
		const h1 = store.record("f.ts", "v1", [1]);
		const h2 = store.record("f.ts", "v2", [2, 3]);
		expect([...store.byHash("f.ts", h1)!.seenLines!]).toEqual([1]);
		expect([...store.byHash("f.ts", h2)!.seenLines!].sort((a, b) => a - b)).toEqual([2, 3]);
	});

	it("relocate preserves seenLines under new path", () => {
		const store = new InMemorySnapshotStore();
		const h = store.record("old.ts", "x", [5, 6]);
		store.relocate("old.ts", "new.ts");
		const snap = store.byHash("new.ts", h)!;
		expect([...snap.seenLines!].sort((a, b) => a - b)).toEqual([5, 6]);
		expect(snap.path).toBe("new.ts");
	});
});
