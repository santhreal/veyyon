import { describe, expect, it } from "bun:test";
import {
	DEFAULT_MAX_PATHS,
	DEFAULT_MAX_TOTAL_BYTES,
	DEFAULT_MAX_VERSIONS_PER_PATH,
	InMemorySnapshotStore,
	mergeClippedLines,
	mergeSeenLines,
	type Snapshot,
} from "../src/snapshots";

describe("snapshot constants", () => {
	it("DEFAULT_MAX_PATHS is 30", () => {
		expect(DEFAULT_MAX_PATHS).toBe(30);
	});
	it("DEFAULT_MAX_VERSIONS_PER_PATH is 4", () => {
		expect(DEFAULT_MAX_VERSIONS_PER_PATH).toBe(4);
	});
	it("DEFAULT_MAX_TOTAL_BYTES is 64MB", () => {
		expect(DEFAULT_MAX_TOTAL_BYTES).toBe(64 * 1024 * 1024);
	});
});

describe("mergeSeenLines", () => {
	it("does nothing for undefined lines", () => {
		const snap: Snapshot = { path: "/a", text: "x", hash: "h", recordedAt: 0 };
		mergeSeenLines(snap, undefined);
		expect(snap.seenLines).toBeUndefined();
	});
	it("creates set and adds lines", () => {
		const snap: Snapshot = { path: "/a", text: "x", hash: "h", recordedAt: 0 };
		mergeSeenLines(snap, [1, 2, 3]);
		expect(snap.seenLines).toEqual(new Set([1, 2, 3]));
	});
	it("merges into existing set", () => {
		const snap: Snapshot = {
			path: "/a",
			text: "x",
			hash: "h",
			recordedAt: 0,
			seenLines: new Set([1, 2]),
		};
		mergeSeenLines(snap, [3, 4]);
		expect(snap.seenLines).toEqual(new Set([1, 2, 3, 4]));
	});
	it("handles empty iterable", () => {
		const snap: Snapshot = { path: "/a", text: "x", hash: "h", recordedAt: 0 };
		mergeSeenLines(snap, []);
		expect(snap.seenLines).toBeDefined();
		expect(snap.seenLines!.size).toBe(0);
	});
	it("handles duplicate lines", () => {
		const snap: Snapshot = { path: "/a", text: "x", hash: "h", recordedAt: 0 };
		mergeSeenLines(snap, [1, 1, 2, 2]);
		expect(snap.seenLines).toEqual(new Set([1, 2]));
	});
});

describe("mergeClippedLines", () => {
	it("does nothing for undefined lines", () => {
		const snap: Snapshot = { path: "/a", text: "x", hash: "h", recordedAt: 0 };
		mergeClippedLines(snap, undefined);
		expect(snap.clippedLines).toBeUndefined();
	});
	it("creates set and adds lines", () => {
		const snap: Snapshot = { path: "/a", text: "x", hash: "h", recordedAt: 0 };
		mergeClippedLines(snap, [5, 10]);
		expect(snap.clippedLines).toEqual(new Set([5, 10]));
	});
	it("merges into existing set", () => {
		const snap: Snapshot = {
			path: "/a",
			text: "x",
			hash: "h",
			recordedAt: 0,
			clippedLines: new Set([1]),
		};
		mergeClippedLines(snap, [2, 3]);
		expect(snap.clippedLines).toEqual(new Set([1, 2, 3]));
	});
});

describe("InMemorySnapshotStore", () => {
	it("head returns null for unknown path", () => {
		const store = new InMemorySnapshotStore();
		expect(store.head("/unknown")).toBeNull();
	});
	it("record returns hash and stores snapshot", () => {
		const store = new InMemorySnapshotStore();
		const hash = store.record("/a.ts", "hello");
		expect(typeof hash).toBe("string");
		expect(hash.length).toBeGreaterThan(0);
		expect(store.head("/a.ts")).not.toBeNull();
	});
	it("head returns latest snapshot", () => {
		const store = new InMemorySnapshotStore();
		store.record("/a.ts", "version 1");
		store.record("/a.ts", "version 2");
		const head = store.head("/a.ts");
		expect(head?.text).toBe("version 2");
	});
	it("byHash returns snapshot with matching hash", () => {
		const store = new InMemorySnapshotStore();
		const hash = store.record("/a.ts", "hello");
		expect(store.byHash("/a.ts", hash)).not.toBeNull();
	});
	it("byHash returns null for non-matching hash", () => {
		const store = new InMemorySnapshotStore();
		store.record("/a.ts", "hello");
		expect(store.byHash("/a.ts", "wrong-hash")).toBeNull();
	});
	it("byContent returns snapshot with matching content", () => {
		const store = new InMemorySnapshotStore();
		store.record("/a.ts", "hello world");
		expect(store.byContent("/a.ts", "hello world")).not.toBeNull();
	});
	it("byContent returns null for non-matching content", () => {
		const store = new InMemorySnapshotStore();
		store.record("/a.ts", "hello world");
		expect(store.byContent("/a.ts", "different")).toBeNull();
	});
	it("invalidate removes path", () => {
		const store = new InMemorySnapshotStore();
		store.record("/a.ts", "hello");
		store.invalidate("/a.ts");
		expect(store.head("/a.ts")).toBeNull();
	});
	it("clear removes all paths", () => {
		const store = new InMemorySnapshotStore();
		store.record("/a.ts", "hello");
		store.record("/b.ts", "world");
		store.clear();
		expect(store.head("/a.ts")).toBeNull();
		expect(store.head("/b.ts")).toBeNull();
	});
	it("relocate moves snapshots to new path", () => {
		const store = new InMemorySnapshotStore();
		store.record("/old.ts", "hello");
		store.relocate("/old.ts", "/new.ts");
		expect(store.head("/old.ts")).toBeNull();
		expect(store.head("/new.ts")).not.toBeNull();
	});
	it("recordSeenLines adds seen lines to snapshot", () => {
		const store = new InMemorySnapshotStore();
		const hash = store.record("/a.ts", "hello");
		store.recordSeenLines("/a.ts", hash, [1, 2, 3]);
		const head = store.head("/a.ts");
		expect(head?.seenLines).toEqual(new Set([1, 2, 3]));
	});
	it("recordClippedLines adds clipped lines to snapshot", () => {
		const store = new InMemorySnapshotStore();
		const hash = store.record("/a.ts", "hello");
		store.recordClippedLines("/a.ts", hash, [5, 10]);
		const head = store.head("/a.ts");
		expect(head?.clippedLines).toEqual(new Set([5, 10]));
	});
	it("findByHash returns all snapshots with matching hash across paths", () => {
		const store = new InMemorySnapshotStore();
		const text = "same content";
		store.record("/a.ts", text);
		store.record("/b.ts", text);
		const hash = store.head("/a.ts")!.hash;
		const found = store.findByHash(hash);
		expect(found.length).toBeGreaterThanOrEqual(2);
	});
	it("record stores seenLines when provided", () => {
		const store = new InMemorySnapshotStore();
		store.record("/a.ts", "hello", [1, 2]);
		expect(store.head("/a.ts")?.seenLines).toEqual(new Set([1, 2]));
	});
});
