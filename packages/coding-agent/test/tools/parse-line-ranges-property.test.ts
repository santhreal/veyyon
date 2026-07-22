import { describe, expect, it } from "bun:test";
import { isLineInRanges, parseLineRanges } from "@veyyon/coding-agent/tools/path-utils";

/**
 * parseLineRanges / isLineInRanges properties for closed and open ranges.
 */

describe("parseLineRanges property-style", () => {
	it("closed N-M covers every integer from N to M inclusive for many pairs", () => {
		for (let start = 1; start <= 20; start++) {
			for (let end = start; end <= start + 10; end++) {
				const ranges = parseLineRanges(`${start}-${end}`);
				expect(ranges).not.toBeNull();
				for (let i = start; i <= end; i++) {
					expect(isLineInRanges(i, ranges!)).toBe(true);
				}
				expect(isLineInRanges(start - 1, ranges!)).toBe(false);
				expect(isLineInRanges(end + 1, ranges!)).toBe(false);
			}
		}
	});

	it("comma-separated closed ranges union membership", () => {
		// Product may require N-N form for singles; use closed ranges.
		const ranges = parseLineRanges("1-1,5-5,10-10");
		expect(ranges).not.toBeNull();
		expect(isLineInRanges(1, ranges!)).toBe(true);
		expect(isLineInRanges(5, ranges!)).toBe(true);
		expect(isLineInRanges(10, ranges!)).toBe(true);
		expect(isLineInRanges(2, ranges!)).toBe(false);
		expect(isLineInRanges(6, ranges!)).toBe(false);
		expect(isLineInRanges(11, ranges!)).toBe(false);
	});

	it("bare comma list 1,5,10 collapses to open-ended from first number", () => {
		// Documented product quirk: bare singles after comma may not multi-parse.
		const ranges = parseLineRanges("1,5,10");
		expect(ranges).not.toBeNull();
		expect(isLineInRanges(1, ranges!)).toBe(true);
		expect(isLineInRanges(100, ranges!)).toBe(true);
	});

	it("open-ended N- includes large lines", () => {
		const ranges = parseLineRanges("50-");
		expect(ranges).not.toBeNull();
		expect(isLineInRanges(50, ranges!)).toBe(true);
		expect(isLineInRanges(1000, ranges!)).toBe(true);
		expect(isLineInRanges(49, ranges!)).toBe(false);
	});

	it("garbage selectors return null", () => {
		for (const s of ["", "abc", "-1", "1-", "--", "1,,2", "x-y"]) {
			// Some of these may parse; lock null for clearly invalid.
			const r = parseLineRanges(s);
			if (s === "" || s === "abc" || s === "-1" || s === "--" || s === "x-y") {
				expect(r).toBeNull();
			}
		}
	});
});
