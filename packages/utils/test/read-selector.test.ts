/**
 * Tests for the ONE-PLACE read-tool selector splitter in `src/read-selector.ts`.
 *
 * This grammar was previously hand-duplicated in `@veyyon/agent-core`
 * (compaction's `splitReadSelector`) and `@veyyon/coding-agent` (the read tool's
 * `splitPathAndSel`), with "keep in sync" comments on both. It now has one owner
 * here; both packages import it. These tests pin the exact split behavior so the
 * consolidation is safe and any future edit that changes the grammar is caught.
 *
 * The example suite pins the selector shapes the read tool accepts (ranges,
 * `raw`, `conflicts`, compounds) and the paths it must NOT mis-split (leading
 * colon, Windows drive letters, non-selector tails). The property suite locks
 * the structural postconditions over 10k generated inputs: a returned `sel` is
 * always a real selector, `path`+the peeled colons reconstruct the input, and a
 * path with no valid selector tail is returned verbatim. Assertions are on exact
 * values (Law 6); a shrunk counterexample is a real grammar break, never to be
 * papered over (Law 9).
 */
import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { READ_SELECTOR_RANGE_LIST_SRC, splitReadSelector, stripReadSelector } from "../src/read-selector";

const RANGE_LIST_RE = new RegExp(`^${READ_SELECTOR_RANGE_LIST_SRC}$`, "i");
const SELECTOR_RE = new RegExp(`^(?:${READ_SELECTOR_RANGE_LIST_SRC}|raw|conflicts)$`, "i");

describe("splitReadSelector — accepted selector shapes", () => {
	it("peels a plain line number", () => {
		expect(splitReadSelector("a.ts:50")).toEqual({ path: "a.ts", sel: "50" });
	});
	it("peels a line range", () => {
		expect(splitReadSelector("a.ts:50-200")).toEqual({ path: "a.ts", sel: "50-200" });
	});
	it("peels a plus range and a multi-range list", () => {
		expect(splitReadSelector("a.ts:50+10")).toEqual({ path: "a.ts", sel: "50+10" });
		expect(splitReadSelector("a.ts:5-16,960-973")).toEqual({ path: "a.ts", sel: "5-16,960-973" });
	});
	it("peels the `..` range alias and `L`-prefixed refs", () => {
		expect(splitReadSelector("a.ts:2724..2727")).toEqual({ path: "a.ts", sel: "2724..2727" });
		expect(splitReadSelector("a.ts:L5-L9")).toEqual({ path: "a.ts", sel: "L5-L9" });
	});
	it("peels the `raw` and `conflicts` markers", () => {
		expect(splitReadSelector("a.ts:raw")).toEqual({ path: "a.ts", sel: "raw" });
		expect(splitReadSelector("a.ts:conflicts")).toEqual({ path: "a.ts", sel: "conflicts" });
	});
	it("peels a compound range:raw / raw:range tail as one selector", () => {
		expect(splitReadSelector("a.ts:1-50:raw")).toEqual({ path: "a.ts", sel: "1-50:raw" });
		expect(splitReadSelector("a.ts:raw:1-50")).toEqual({ path: "a.ts", sel: "raw:1-50" });
	});
});

describe("splitReadSelector — paths it must NOT mis-split", () => {
	it("leaves a bare path untouched", () => {
		expect(splitReadSelector("a.ts")).toEqual({ path: "a.ts" });
	});
	it("never treats a leading colon as a selector", () => {
		expect(splitReadSelector(":50")).toEqual({ path: ":50" });
		expect(splitReadSelector("::")).toEqual({ path: "::" });
	});
	it("leaves a Windows drive-letter path intact (drive colon is not a range)", () => {
		expect(splitReadSelector("C:\\src\\main.ts")).toEqual({ path: "C:\\src\\main.ts" });
	});
	it("splits a Windows path that carries a real selector, keeping the drive colon", () => {
		expect(splitReadSelector("C:\\src\\main.ts:50-200")).toEqual({ path: "C:\\src\\main.ts", sel: "50-200" });
		expect(splitReadSelector("C:\\src\\main.ts:raw")).toEqual({ path: "C:\\src\\main.ts", sel: "raw" });
	});
	it("leaves a non-selector tail (empty, word, URL) on the path", () => {
		expect(splitReadSelector("a.ts:")).toEqual({ path: "a.ts:" });
		expect(splitReadSelector("a:b:c")).toEqual({ path: "a:b:c" });
		expect(splitReadSelector("conflict://1")).toEqual({ path: "conflict://1" });
	});
	it("does not form a compound from two ranges (must be one range + one raw)", () => {
		// `x:1-2:3-4` — inner `1-2` and outer `3-4` are both ranges, so only the
		// outer peels; the inner colon stays in the path.
		expect(splitReadSelector("x:1-2:3-4")).toEqual({ path: "x:1-2", sel: "3-4" });
	});
});

describe("stripReadSelector", () => {
	it("returns just the path for selector and non-selector inputs", () => {
		expect(stripReadSelector("a.ts:50-200")).toBe("a.ts");
		expect(stripReadSelector("a.ts:1-50:raw")).toBe("a.ts");
		expect(stripReadSelector("C:\\src\\main.ts")).toBe("C:\\src\\main.ts");
		expect(stripReadSelector("a:b:c")).toBe("a:b:c");
	});
});

describe("splitReadSelector — structural properties", () => {
	const RUNS = { numRuns: 10_000 } as const;
	// A character set rich enough to build paths, selectors, drive letters, URLs,
	// and near-miss selector tails.
	const pathArb = fc.string({ maxLength: 30, unit: fc.constantFrom(..."abc.:-+,LrawconflictsL0129\\/".split("")) });

	it("a returned sel is always a valid selector chunk or valid compound", () => {
		fc.assert(
			fc.property(pathArb, s => {
				const { sel } = splitReadSelector(s);
				if (sel === undefined) return;
				// Either a single selector chunk, or a `range:raw`/`raw:range` compound.
				const isSingle = SELECTOR_RE.test(sel);
				const [a, b, ...rest] = sel.split(":");
				const isCompound =
					rest.length === 0 &&
					b !== undefined &&
					((/^raw$/i.test(a) && RANGE_LIST_RE.test(b)) || (RANGE_LIST_RE.test(a) && /^raw$/i.test(b)));
				expect(isSingle || isCompound).toBe(true);
			}),
			RUNS,
		);
	});

	it("path + the peeled `:sel` reconstructs the input exactly", () => {
		fc.assert(
			fc.property(pathArb, s => {
				const { path, sel } = splitReadSelector(s);
				expect(sel === undefined ? path : `${path}:${sel}`).toBe(s);
			}),
			RUNS,
		);
	});

	it("when nothing is peeled, the input is returned verbatim with no sel", () => {
		fc.assert(
			fc.property(pathArb, s => {
				const { path, sel } = splitReadSelector(s);
				if (sel === undefined) expect(path).toBe(s);
			}),
			RUNS,
		);
	});

	it("a peeled base path is always shorter than the input (progress, no infinite peel)", () => {
		fc.assert(
			fc.property(pathArb, s => {
				const { path, sel } = splitReadSelector(s);
				if (sel !== undefined) expect(path.length).toBeLessThan(s.length);
			}),
			RUNS,
		);
	});
});
