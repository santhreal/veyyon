/**
 * Full DEL then HEAD/TAIL rebuild for large n including 600 and 1000.
 * Why: scale clear/rebuild beyond 500 past-6000 scale suite.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, computeFileHash, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 full clear rebuild n600 1000", () => {
	for (const n of [600, 800, 1000]) {
		it(`n=${n} HEAD rebuild hash-stable`, () => {
			const base = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
			const h0 = computeFileHash(base);
			const empty = applyEdits(base, parsePatch(`DEL 1.=${n}`).edits).text;
			expect(empty).toBe("");
			const rows = Array.from({ length: n }, (_, i) => `+L${i + 1}`).join("\n");
			const back = applyEdits(empty, parsePatch(`INS.HEAD:\n${rows}`).edits).text;
			expect(back).toBe(base);
			expect(computeFileHash(back)).toBe(h0);
		});
	}
});
