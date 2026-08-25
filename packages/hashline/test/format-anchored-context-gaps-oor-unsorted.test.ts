/**
 * formatAnchoredContext: ±2 context, gap ellipsis, out-of-range skip.
 *
 * WHY THIS SUITE EXISTS. Mismatch and block-unresolved messages both render
 * through this helper. MISMATCH_CONTEXT is 2. Adjacent windows merge; a gap
 * of three or more unselected lines becomes a single `"..."` row. Out-of-range
 * anchors contribute no rows (they are not clamped to 1 or N — clamping would
 * star the wrong line). Unsorted / duplicated anchors must not reorder the
 * file or emit duplicate numbered rows.
 *
 * The star is the ANCHOR, not every displayed line. Context neighbours get a
 * leading space so a renderer that strips left-padding still keeps the column.
 */
import { describe, expect, it } from "bun:test";
import { formatAnchoredContext, MISMATCH_CONTEXT } from "../src/messages";

function fileLines(n: number): string[] {
	return Array.from({ length: n }, (_, i) => `L${i + 1}`);
}

describe("MISMATCH_CONTEXT is two lines either side", () => {
	it("exports 2 — a silent change here would widen every mismatch preview", () => {
		expect(MISMATCH_CONTEXT).toBe(2);
	});

	it("an interior anchor on a 9-line file shows lines 2-6 starred at 4", () => {
		expect(formatAnchoredContext([4], fileLines(9))).toEqual([" 2:L2", " 3:L3", "*4:L4", " 5:L5", " 6:L6"]);
	});

	it("line 1 has no above-context; window is 1-3", () => {
		expect(formatAnchoredContext([1], fileLines(5))).toEqual(["*1:L1", " 2:L2", " 3:L3"]);
	});

	it("the last line has no below-context", () => {
		expect(formatAnchoredContext([5], fileLines(5))).toEqual([" 3:L3", " 4:L4", "*5:L5"]);
	});

	it("line 2's window starts at 1 (clamped lo), not a phantom 0", () => {
		expect(formatAnchoredContext([2], fileLines(6))).toEqual([" 1:L1", "*2:L2", " 3:L3", " 4:L4"]);
	});
});

describe("merged windows vs ellipsis gaps", () => {
	it("anchors 3 and 5 merge because their ±2 windows overlap", () => {
		const rows = formatAnchoredContext([3, 5], fileLines(10));
		expect(rows).not.toContain("...");
		expect(rows.filter(r => r.startsWith("*"))).toEqual(["*3:L3", "*5:L5"]);
		expect(rows[0]).toBe(" 1:L1");
		expect(rows.at(-1)).toBe(" 7:L7");
	});

	it("anchors 1 and 10 on a 12-line file are separated by a single ellipsis", () => {
		const rows = formatAnchoredContext([1, 10], fileLines(12));
		expect(rows.filter(r => r === "...")).toEqual(["..."]);
		expect(rows.filter(r => r.startsWith("*"))).toEqual(["*1:L1", "*10:L10"]);
		expect(rows).toEqual([
			"*1:L1",
			" 2:L2",
			" 3:L3",
			"...",
			" 8:L8",
			" 9:L9",
			"*10:L10",
			" 11:L11",
			" 12:L12",
		]);
	});

	it("anchors 1 and 6 on a 10-line file: windows 1-3 and 4-8 abut, so NO ellipsis", () => {
		const rows = formatAnchoredContext([1, 6], fileLines(10));
		expect(rows).not.toContain("...");
		expect(rows[0]).toBe("*1:L1");
		expect(rows).toContain(" 4:L4");
		expect(rows).toContain("*6:L6");
	});

	it("three far-apart anchors emit two ellipsis rows, not one collapsed gap", () => {
		const rows = formatAnchoredContext([1, 10, 20], fileLines(22));
		expect(rows.filter(r => r === "...")).toEqual(["...", "..."]);
		expect(rows.filter(r => r.startsWith("*"))).toEqual(["*1:L1", "*10:L10", "*20:L20"]);
	});
});

describe("out-of-range and degenerate anchors", () => {
	it("line 0 is skipped, not clamped to 1 (clamping would star the wrong line)", () => {
		expect(formatAnchoredContext([0], fileLines(3))).toEqual([]);
	});

	it("a negative line is skipped", () => {
		expect(formatAnchoredContext([-4], fileLines(3))).toEqual([]);
	});

	it("line N+1 is skipped", () => {
		expect(formatAnchoredContext([4], fileLines(3))).toEqual([]);
	});

	it("a mix of in-range and OOR keeps only the in-range window", () => {
		expect(formatAnchoredContext([0, 2, 99], fileLines(3))).toEqual([" 1:L1", "*2:L2", " 3:L3"]);
	});

	it("duplicate anchors do not duplicate rows", () => {
		expect(formatAnchoredContext([2, 2, 2], fileLines(4)).filter(r => r.startsWith("*"))).toEqual(["*2:L2"]);
	});

	it("unsorted anchors still emit in file order", () => {
		const rows = formatAnchoredContext([5, 1], fileLines(6));
		expect(rows.filter(r => r.startsWith("*"))).toEqual(["*1:L1", "*5:L5"]);
	});

	it("an empty anchor list yields no rows even on a non-empty file", () => {
		expect(formatAnchoredContext([], fileLines(4))).toEqual([]);
	});
});

describe("body text is the file's actual line, including empty and colon-bearing", () => {
	it("an empty file line still prints `N:` with nothing after the colon", () => {
		expect(formatAnchoredContext([1], [""])).toEqual(["*1:"]);
	});

	it("a line that itself looks like a numbered row is not re-parsed", () => {
		expect(formatAnchoredContext([1], ["2:not-a-line-number"])).toEqual(["*1:2:not-a-line-number"]);
	});

	it("a hashline header stored as content is not treated as a section", () => {
		expect(formatAnchoredContext([1], ["[foo.ts#ABCD]"])).toEqual(["*1:[foo.ts#ABCD]"]);
	});
});
