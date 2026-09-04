/**
 * record with seenLines sets and unions.
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore } from "@veyyon/hashline";

describe("record seenLines matrix", () => {
	it("initial set", () => {
		const store = new InMemorySnapshotStore();
		const h = store.record("f.ts", "a\nb\nc", [1, 3]);
		expect([...store.byHash("f.ts", h)!.seenLines!].sort((a, b) => a - b)).toEqual([1, 3]);
	});

	it("union on re-record", () => {
		const store = new InMemorySnapshotStore();
		const h = store.record("f.ts", "a\nb\nc", [1]);
		store.record("f.ts", "a\nb\nc", [2, 3]);
		expect([...store.byHash("f.ts", h)!.seenLines!].sort((a, b) => a - b)).toEqual([1, 2, 3]);
	});

	it("recordSeenLines after", () => {
		const store = new InMemorySnapshotStore();
		const h = store.record("f.ts", "x");
		store.recordSeenLines("f.ts", h, [1, 2, 3]);
		expect([...store.head("f.ts")!.seenLines!].sort((a, b) => a - b)).toEqual([1, 2, 3]);
	});
});
