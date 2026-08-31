/**
 * Square sizes n²: INS.HEAD of n rows on n² file.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits square sizes", () => {
	for (const side of [2, 3, 4, 5]) {
		const n = side * side;
		it(`n=${n} INS.HEAD ${side} rows`, () => {
			const base = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
			const rows = Array.from({ length: side }, (_, i) => `+H${i}`).join("\n");
			const { text } = applyEdits(base, parsePatch(`INS.HEAD:\n${rows}`).edits);
			expect(text.split("\n")).toHaveLength(n + side);
			expect(text.split("\n").slice(0, side)).toEqual(Array.from({ length: side }, (_, i) => `H${i}`));
		});
	}
});
