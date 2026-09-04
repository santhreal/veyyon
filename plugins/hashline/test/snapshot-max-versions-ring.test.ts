/**
 * maxVersionsPerPath ring drops oldest.
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore } from "@veyyon/hashline";

describe("InMemorySnapshotStore version ring", () => {
	it("keeps only last N versions", () => {
		const store = new InMemorySnapshotStore({ maxVersionsPerPath: 3 });
		const h0 = store.record("f.ts", "v0");
		const h1 = store.record("f.ts", "v1");
		const h2 = store.record("f.ts", "v2");
		const h3 = store.record("f.ts", "v3");
		expect(store.byHash("f.ts", h0)).toBeNull();
		expect(store.byHash("f.ts", h1)!.text).toBe("v1");
		expect(store.byHash("f.ts", h2)!.text).toBe("v2");
		expect(store.byHash("f.ts", h3)!.text).toBe("v3");
		expect(store.head("f.ts")!.text).toBe("v3");
	});
});
