/**
 * byHash returns a version for the path when hash matches.
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, computeFileHash } from "@veyyon/hashline";

describe("byHash path lookup", () => {
	it("returns latest matching content for path", () => {
		const store = new InMemorySnapshotStore();
		const t1 = "one";
		const t2 = "two";
		const h1 = store.record("f.ts", t1);
		const h2 = store.record("f.ts", t2);
		expect(store.byHash("f.ts", h1)!.text).toBe(t1);
		expect(store.byHash("f.ts", h2)!.text).toBe(t2);
		expect(store.byHash("f.ts", h2)!.hash).toBe(computeFileHash(t2));
	});

	it("null for wrong path", () => {
		const store = new InMemorySnapshotStore();
		const h = store.record("a.ts", "x");
		expect(store.byHash("b.ts", h)).toBeNull();
	});
});
