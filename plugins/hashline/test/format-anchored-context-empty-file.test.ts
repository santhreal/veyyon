/**
 * formatAnchoredContext on empty and single-line files.
 */
import { describe, expect, it } from "bun:test";
import { formatAnchoredContext } from "../src/messages";

describe("formatAnchoredContext edge files", () => {
	it("empty file any anchors yields []", () => {
		expect(formatAnchoredContext([1], [])).toEqual([]);
		expect(formatAnchoredContext([1, 2, 3], [])).toEqual([]);
	});

	it("single line file", () => {
		expect(formatAnchoredContext([1], ["only"])).toEqual(["*1:only"]);
		expect(formatAnchoredContext([2], ["only"])).toEqual([]);
	});

	it("two line file anchors both", () => {
		const rows = formatAnchoredContext([1, 2], ["a", "b"]);
		expect(rows.filter(r => r.startsWith("*"))).toEqual(["*1:a", "*2:b"]);
	});
});
