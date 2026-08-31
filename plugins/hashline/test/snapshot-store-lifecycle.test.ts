/**
 * InMemorySnapshotStore: record fusion, version ring, seenLines, relocate, findByHash.
 */
import { describe, expect, it } from "bun:test";
import { computeFileHash, InMemorySnapshotStore } from "@veyyon/hashline";

describe("InMemorySnapshotStore record and head", () => {
	it("record returns content hash and head is that version", () => {
		const store = new InMemorySnapshotStore();
		const text = "alpha\nbeta\n";
		const hash = store.record("a.ts", text);
		expect(hash).toBe(computeFileHash(text));
		const head = store.head("a.ts");
		expect(head).not.toBeNull();
		expect(head!.path).toBe("a.ts");
		expect(head!.text).toBe(text);
		expect(head!.hash).toBe(hash);
	});

	it("identical content fuses and reuses the same tag", () => {
		const store = new InMemorySnapshotStore();
		const h1 = store.record("a.ts", "same");
		const h2 = store.record("a.ts", "same");
		expect(h1).toBe(h2);
		// still one head version of that text
		expect(store.head("a.ts")!.text).toBe("same");
	});

	it("new content unshifts a new version; byHash finds both", () => {
		const store = new InMemorySnapshotStore({ maxVersionsPerPath: 4 });
		const h1 = store.record("a.ts", "v1");
		const h2 = store.record("a.ts", "v2");
		expect(h1).not.toBe(h2);
		expect(store.head("a.ts")!.text).toBe("v2");
		expect(store.byHash("a.ts", h1)!.text).toBe("v1");
		expect(store.byHash("a.ts", h2)!.text).toBe("v2");
	});

	it("byContent matches exact text not just hash", () => {
		const store = new InMemorySnapshotStore();
		store.record("a.ts", "exact body");
		expect(store.byContent("a.ts", "exact body")!.text).toBe("exact body");
		expect(store.byContent("a.ts", "other")).toBeNull();
	});

	it("missing path returns null for head/byHash/byContent", () => {
		const store = new InMemorySnapshotStore();
		expect(store.head("nope")).toBeNull();
		expect(store.byHash("nope", "AAAA")).toBeNull();
		expect(store.byContent("nope", "x")).toBeNull();
	});
});

describe("InMemorySnapshotStore seenLines", () => {
	it("record merges seenLines into the snapshot", () => {
		const store = new InMemorySnapshotStore();
		const hash = store.record("a.ts", "a\nb\nc", [1, 2]);
		const snap = store.byHash("a.ts", hash)!;
		expect([...snap.seenLines!].sort((a, b) => a - b)).toEqual([1, 2]);
	});

	it("re-record same content unions seenLines", () => {
		const store = new InMemorySnapshotStore();
		const hash = store.record("a.ts", "a\nb\nc", [1]);
		store.record("a.ts", "a\nb\nc", [3]);
		const snap = store.byHash("a.ts", hash)!;
		expect([...snap.seenLines!].sort((a, b) => a - b)).toEqual([1, 3]);
	});

	it("recordSeenLines attaches after mint", () => {
		const store = new InMemorySnapshotStore();
		const hash = store.record("a.ts", "x\ny");
		expect(store.head("a.ts")!.seenLines).toBeUndefined();
		store.recordSeenLines("a.ts", hash, [1, 2]);
		expect([...store.head("a.ts")!.seenLines!].sort((a, b) => a - b)).toEqual([1, 2]);
	});

	it("recordSeenLines is no-op for unknown hash", () => {
		const store = new InMemorySnapshotStore();
		store.record("a.ts", "x");
		store.recordSeenLines("a.ts", "ZZZZ", [1]);
		expect(store.head("a.ts")!.seenLines).toBeUndefined();
	});
});

describe("InMemorySnapshotStore version ring and eviction", () => {
	it("maxVersionsPerPath drops oldest beyond the ring", () => {
		const store = new InMemorySnapshotStore({ maxVersionsPerPath: 2 });
		const h1 = store.record("a.ts", "one");
		const h2 = store.record("a.ts", "two");
		const h3 = store.record("a.ts", "three");
		expect(store.byHash("a.ts", h3)!.text).toBe("three");
		expect(store.byHash("a.ts", h2)!.text).toBe("two");
		// oldest dropped
		expect(store.byHash("a.ts", h1)).toBeNull();
	});

	it("invalidate removes path history", () => {
		const store = new InMemorySnapshotStore();
		store.record("a.ts", "x");
		store.invalidate("a.ts");
		expect(store.head("a.ts")).toBeNull();
	});

	it("clear removes all paths", () => {
		const store = new InMemorySnapshotStore();
		store.record("a.ts", "x");
		store.record("b.ts", "y");
		store.clear();
		expect(store.head("a.ts")).toBeNull();
		expect(store.head("b.ts")).toBeNull();
	});
});

describe("InMemorySnapshotStore relocate and findByHash", () => {
	it("relocate moves history and updates snapshot path", () => {
		const store = new InMemorySnapshotStore();
		const hash = store.record("old.ts", "body");
		store.relocate("old.ts", "new.ts");
		expect(store.head("old.ts")).toBeNull();
		expect(store.head("new.ts")!.text).toBe("body");
		expect(store.head("new.ts")!.path).toBe("new.ts");
		expect(store.byHash("new.ts", hash)!.text).toBe("body");
	});

	it("relocate no-op when source empty", () => {
		const store = new InMemorySnapshotStore();
		store.record("keep.ts", "k");
		store.relocate("missing.ts", "dest.ts");
		expect(store.head("keep.ts")!.text).toBe("k");
		expect(store.head("dest.ts")).toBeNull();
	});

	it("relocate merges into existing dest history without duplicate hashes", () => {
		const store = new InMemorySnapshotStore({ maxVersionsPerPath: 4 });
		const sharedText = "same";
		const h = store.record("from.ts", sharedText);
		store.record("to.ts", sharedText);
		store.record("to.ts", "other");
		store.relocate("from.ts", "to.ts");
		// shared hash appears once
		const matches = store.findByHash(h).filter(s => s.path === "to.ts");
		expect(matches.length).toBe(1);
		expect(store.head("from.ts")).toBeNull();
	});

	it("findByHash returns matches across paths", () => {
		const store = new InMemorySnapshotStore();
		const text = "shared-content-body";
		const hash = computeFileHash(text);
		store.record("a.ts", text);
		store.record("b.ts", text);
		store.record("c.ts", "different");
		const found = store.findByHash(hash);
		expect(found.map(s => s.path).sort()).toEqual(["a.ts", "b.ts"]);
		expect(found.every(s => s.text === text)).toBe(true);
	});

	it("findByHash empty for unknown tag", () => {
		const store = new InMemorySnapshotStore();
		store.record("a.ts", "x");
		expect(store.findByHash("0000")).toEqual([]);
	});
});
