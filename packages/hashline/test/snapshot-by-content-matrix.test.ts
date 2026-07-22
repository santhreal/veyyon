/**
 * SnapshotStore.byContent exact text match (not hash-only).
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, computeFileHash } from "@veyyon/hashline";

describe("InMemorySnapshotStore byContent", () => {
	it("finds exact text", () => {
		const store = new InMemorySnapshotStore();
		store.record("a.ts", "exact");
		expect(store.byContent("a.ts", "exact")!.text).toBe("exact");
		expect(store.byContent("a.ts", "other")).toBeNull();
	});

	it("distinguishes same-hash-risk by full text equality", () => {
		// byContent requires full text match even if hashes could collide
		const store = new InMemorySnapshotStore();
		const t1 = "version-one-unique-body";
		const t2 = "version-two-unique-body";
		store.record("a.ts", t1);
		store.record("a.ts", t2);
		expect(store.byContent("a.ts", t1)!.text).toBe(t1);
		expect(store.byContent("a.ts", t2)!.text).toBe(t2);
		expect(computeFileHash(t1)).not.toBe(computeFileHash(t2));
	});

	it("null for wrong path", () => {
		const store = new InMemorySnapshotStore();
		store.record("a.ts", "x");
		expect(store.byContent("b.ts", "x")).toBeNull();
	});
});
