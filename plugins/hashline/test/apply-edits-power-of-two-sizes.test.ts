/**
 * Power-of-two file sizes: full DEL and full SWAP replace.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits power of two sizes", () => {
	for (const n of [1, 2, 4, 8, 16, 32, 64]) {
		it(`n=${n} full DEL`, () => {
			const base = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
			const patch = n === 1 ? "DEL 1" : `DEL 1.=${n}`;
			expect(applyEdits(base, parsePatch(patch).edits).text).toBe("");
		});

		it(`n=${n} full SWAP to ONE`, () => {
			const base = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
			const { text } = applyEdits(base, parsePatch(`SWAP 1.=${n}:\n+ONE`).edits);
			expect(text).toBe("ONE");
		});
	}
});
