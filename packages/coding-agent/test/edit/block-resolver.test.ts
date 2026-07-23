import { afterAll, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import { nativeBlockResolver } from "@veyyon/coding-agent/edit/hashline/block-resolver";
import * as natives from "@veyyon/natives";

/**
 * nativeBlockResolver wraps the native tree-sitter blockRangeAt with a content-keyed
 * FIFO memo. Spy blockRangeAt (NOT mock.module on the whole natives package) so later
 * suites still see the real tree-sitter — mock.module("@veyyon/natives") is
 * process-global and was poisoning SWAP.BLK / markdown block e2e tests
 * (FINDING-FULL-SUITE-ORDER-DEPENDENT-POLLUTION).
 */

let calls = 0;
let blockRangeSpy: ReturnType<typeof spyOn> | undefined;

beforeAll(() => {
	blockRangeSpy = spyOn(natives, "blockRangeAt").mockImplementation(
		// Match the real BlockRangeOptions shape (lang/path are optional).
		({ line }: { code: string; lang?: string; path?: string; line: number }) => {
			calls += 1;
			return line <= 0 ? null : { startLine: line, endLine: line + 2 };
		},
	);
});

afterAll(() => {
	blockRangeSpy?.mockRestore();
	blockRangeSpy = undefined;
	mock.restore();
});

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
		const tag = "evict-run";
		const first = { path: "p.ts", text: `${tag}-0`, line: 1 };
		calls = 0;
		nativeBlockResolver(first);
		for (let i = 1; i < 512; i += 1) {
			nativeBlockResolver({ path: "p.ts", text: `${tag}-${i}`, line: 1 });
		}
		expect(calls).toBe(512);

		nativeBlockResolver(first);
		expect(calls).toBe(512);

		for (let i = 512; i < 1100; i += 1) {
			nativeBlockResolver({ path: "p.ts", text: `${tag}-${i}`, line: 1 });
		}
		const before = calls;
		nativeBlockResolver(first);
		expect(calls).toBe(before + 1);
	});
});
