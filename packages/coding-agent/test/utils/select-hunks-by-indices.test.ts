import { describe, expect, it } from "bun:test";
import type { DiffHunk } from "@veyyon/coding-agent/commit/types";
import { selectHunksByIndices } from "@veyyon/coding-agent/utils/git";

/**
 * selectHunksByIndices is the SINGLE owner of index-based hunk selection, created by
 * DEDUP-SELECT-HUNKS-BY-INDICES-DUPLICATED after the same 1-based index filter was
 * hand-rolled twice (the internal selector in utils/git.ts and a private copy in the
 * git_hunk custom tool). This suite pins the shared contract so a future re-divergence
 * is caught: indices are 1-based (hunk.index is 0-based, so index 1 selects hunk.index
 * 0), each requested index is floored and clamped to at least 1, duplicates collapse,
 * out-of-range indices select nothing, results keep hunk order (not request order), and
 * an empty index list selects nothing (the "all vs none" default is each caller's job,
 * deliberately NOT baked into this shared helper).
 */

const h = (index: number): DiffHunk => ({
	index,
	header: "",
	oldStart: 0,
	oldLines: 0,
	newStart: 0,
	newLines: 0,
	content: `c${index}`,
});
// Displayed 1-based numbers are 1,2,3,4 for hunk.index 0,1,2,3.
const hunks = [h(0), h(1), h(2), h(3)];
const picked = (indices: number[]): number[] => selectHunksByIndices(hunks, indices).map(x => x.index);

describe("selectHunksByIndices", () => {
	it("maps 1-based indices onto 0-based hunk.index", () => {
		expect(picked([1, 3])).toEqual([0, 2]);
	});

	it("floors a fractional index", () => {
		expect(picked([2.9])).toEqual([1]);
	});

	it("clamps a zero or negative index up to 1", () => {
		expect(picked([0])).toEqual([0]);
		expect(picked([-5])).toEqual([0]);
	});

	it("collapses duplicate indices", () => {
		expect(picked([2, 2, 2])).toEqual([1]);
	});

	it("selects nothing for an out-of-range index", () => {
		expect(picked([99])).toEqual([]);
	});

	it("selects nothing for an empty index list (caller owns the all-vs-none default)", () => {
		expect(picked([])).toEqual([]);
	});

	it("returns hunks in hunk order regardless of request order", () => {
		expect(picked([4, 1])).toEqual([0, 3]);
	});
});
