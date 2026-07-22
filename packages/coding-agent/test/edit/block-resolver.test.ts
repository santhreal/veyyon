import { describe, expect, it, mock } from "bun:test";

/**
 * nativeBlockResolver wraps the native tree-sitter blockRangeAt with a content-keyed
 * FIFO memo, because streaming previews re-resolve the same (text, line) on every
 * chunk and a full parse per call would be wasteful. This suite mocks the native so
 * it can count parses and lock the caching contract: (1) an identical (text, line,
 * path) parses once and reuses the span; (2) a NULL result is cached too (an
 * unresolvable block must not be re-parsed on every retry); (3) any differing key
 * component (text, line, or path) is a distinct entry; (4) the cache is FIFO-bounded
 * at 512, so the oldest entry is evicted and re-parsed after the bound is exceeded.
 * A regression would either re-parse cached content (the perf bug the memo exists to
 * prevent) or return a stale span for changed text.
 */

let calls = 0;
mock.module("@veyyon/natives", () => ({
	blockRangeAt: ({ line }: { code: string; path: string; line: number }) => {
		calls += 1;
		return line <= 0 ? null : { startLine: line, endLine: line + 2 };
	},
}));

const { nativeBlockResolver } = await import("@veyyon/coding-agent/edit/hashline/block-resolver");

describe("nativeBlockResolver memoization", () => {
	it("parses once and reuses the span for identical (text, line, path)", () => {
		calls = 0;
		const args = { path: "unique-a.ts", text: "let a = 1", line: 1 };
		expect(nativeBlockResolver(args)).toEqual({ start: 1, end: 3 });
		expect(nativeBlockResolver(args)).toEqual({ start: 1, end: 3 });
		expect(calls).toBe(1);
	});

	it("caches a null (unresolvable) result instead of re-parsing it", () => {
		calls = 0;
		const args = { path: "unique-b.ts", text: "??? not a block", line: 0 };
		expect(nativeBlockResolver(args)).toBeNull();
		expect(nativeBlockResolver(args)).toBeNull();
		expect(calls).toBe(1);
	});

	it("treats a different line, text, or path as a distinct cache entry", () => {
		calls = 0;
		nativeBlockResolver({ path: "unique-c.ts", text: "same text", line: 1 });
		nativeBlockResolver({ path: "unique-c.ts", text: "same text", line: 2 });
		nativeBlockResolver({ path: "unique-c.ts", text: "other text", line: 1 });
		nativeBlockResolver({ path: "unique-c2.ts", text: "same text", line: 1 });
		expect(calls).toBe(4);
	});
});

describe("nativeBlockResolver FIFO eviction", () => {
	it("evicts the oldest entry once the 512-entry bound is exceeded, forcing a re-parse", () => {
		// Fill 512 distinct entries with a run-unique text so this test never collides
		// with entries left by the memoization tests above.
		const tag = "evict-run";
		const first = { path: "p.ts", text: `${tag}-0`, line: 1 };
		calls = 0;
		nativeBlockResolver(first); // entry #1 (oldest)
		for (let i = 1; i < 512; i += 1) {
			nativeBlockResolver({ path: "p.ts", text: `${tag}-${i}`, line: 1 });
		}
		expect(calls).toBe(512); // all misses so far

		// The first entry is still cached at exactly the bound: a re-request is a hit.
		nativeBlockResolver(first);
		expect(calls).toBe(512);

		// Inserting a 513th distinct entry pushes size to the max and evicts the oldest
		// (the FIFO head). After the memoization tests, `first` may not be the literal
		// head, so insert enough fresh entries to guarantee it is evicted, then confirm
		// requesting it re-parses.
		for (let i = 512; i < 1100; i += 1) {
			nativeBlockResolver({ path: "p.ts", text: `${tag}-${i}`, line: 1 });
		}
		const before = calls;
		nativeBlockResolver(first);
		expect(calls).toBe(before + 1); // re-parsed: it was evicted
	});
});
