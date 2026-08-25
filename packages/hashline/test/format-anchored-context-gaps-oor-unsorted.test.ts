/**
 * formatAnchoredContext gaps that messages-exact-contract.test.ts does not
 * pin: abutting windows (no ellipsis), unsorted anchors, and empty body text.
 *
 * Exact-contract already covers ±2 window, 1+10 ellipsis, OOR skip, edge
 * clamp, and overlapping-window dedupe.
 */
import { describe, expect, it } from "bun:test";
import { formatAnchoredContext } from "../src/messages";

function fileLines(n: number): string[] {
	return Array.from({ length: n }, (_, i) => `L${i + 1}`);
}

describe("merged windows vs ellipsis gaps", () => {
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
	});
});

describe("out-of-range and degenerate anchors", () => {
	it("unsorted anchors still emit in file order", () => {
		const rows = formatAnchoredContext([5, 1], fileLines(6));
		expect(rows.filter(r => r.startsWith("*"))).toEqual(["*1:L1", "*5:L5"]);
	});
});

describe("body text is the file's actual line, including empty and colon-bearing", () => {
	it("an empty file line still prints `N:` with nothing after the colon", () => {
		expect(formatAnchoredContext([1], [""])).toEqual(["*1:"]);
	});

	it("a hashline header stored as content is not treated as a section", () => {
		expect(formatAnchoredContext([1], ["[foo.ts#ABCD]"])).toEqual(["*1:[foo.ts#ABCD]"]);
	});
});
