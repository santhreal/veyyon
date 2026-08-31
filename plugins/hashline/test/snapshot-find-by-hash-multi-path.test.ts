/**
 * findByHash returns all paths with same content hash.
 */
import { describe, expect, it } from "bun:test";
import { computeFileHash, InMemorySnapshotStore } from "@veyyon/hashline";

describe("findByHash multi-path", () => {
	it("two paths same content", () => {
		const store = new InMemorySnapshotStore();
		const text = "shared-body-xyz";
		const h = computeFileHash(text);
		store.record("a.ts", text);
		store.record("b.ts", text);
		const found = store.findByHash(h);
		expect(found.map(s => s.path).sort()).toEqual(["a.ts", "b.ts"]);
	});
});
