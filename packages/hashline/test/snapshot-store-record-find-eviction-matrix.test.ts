/**
 * InMemorySnapshotStore: record returns computeFileHash; byHash path isolation;
 * maxVersionsPerPath ring; findByHash cross-path enumeration.
 */
import { describe, expect, it } from "bun:test";
import { computeFileHash, InMemorySnapshotStore } from "@veyyon/hashline";

describe("InMemorySnapshotStore matrix", () => {
	it("record return equals computeFileHash", () => {
		const store = new InMemorySnapshotStore();
		for (const text of ["", "a", "a\nb\n", "x\n\ny"]) {
			const h = store.record("f.ts", text);
			expect(h).toBe(computeFileHash(text));
			expect(store.byHash("f.ts", h)?.text).toBe(text);
			expect(store.head("f.ts")?.text).toBe(text);
			expect(store.head("f.ts")?.hash).toBe(h);
		}
	});

	it("byHash is path-isolated", () => {
		const store = new InMemorySnapshotStore();
		const h = store.record("a.ts", "hello\n");
		expect(store.byHash("a.ts", h)?.text).toBe("hello\n");
		expect(store.byHash("b.ts", h)).toBeNull();
		expect(store.byHash("a.ts", "0000")).toBeNull();
	});

	it("same content different paths share hash, lookups isolated", () => {
		const store = new InMemorySnapshotStore();
		const text = "shared\n";
		const ha = store.record("a.ts", text);
		const hb = store.record("b.ts", text);
		expect(ha).toBe(hb);
		expect(store.byHash("a.ts", ha)?.text).toBe(text);
		expect(store.byHash("b.ts", hb)?.text).toBe(text);
		const found = store.findByHash(ha);
		expect(found.length).toBeGreaterThanOrEqual(2);
		expect(found.map(s => s.path).sort()).toEqual(["a.ts", "b.ts"]);
	});

	it("version history retains prior tags under default maxVersionsPerPath", () => {
		const store = new InMemorySnapshotStore();
		const h1 = store.record("a.ts", "v1\n");
		const h2 = store.record("a.ts", "v2\n");
		expect(h1).not.toBe(h2);
		expect(store.byHash("a.ts", h1)?.text).toBe("v1\n");
		expect(store.byHash("a.ts", h2)?.text).toBe("v2\n");
		expect(store.head("a.ts")?.hash).toBe(h2);
	});

	it("maxVersionsPerPath=1 drops older versions", () => {
		const store = new InMemorySnapshotStore({ maxVersionsPerPath: 1 });
		const h1 = store.record("a.ts", "old\n");
		const h2 = store.record("a.ts", "new\n");
		expect(store.byHash("a.ts", h2)?.text).toBe("new\n");
		expect(store.byHash("a.ts", h1)).toBeNull();
		expect(store.head("a.ts")?.text).toBe("new\n");
	});

	it("byContent finds exact text", () => {
		const store = new InMemorySnapshotStore();
		store.record("a.ts", "exact\n");
		expect(store.byContent("a.ts", "exact\n")?.text).toBe("exact\n");
		expect(store.byContent("a.ts", "other\n")).toBeNull();
	});

	it("invalidate drops path history", () => {
		const store = new InMemorySnapshotStore();
		const h = store.record("a.ts", "gone\n");
		store.invalidate("a.ts");
		expect(store.head("a.ts")).toBeNull();
		expect(store.byHash("a.ts", h)).toBeNull();
	});
});
