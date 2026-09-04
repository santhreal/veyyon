/**
 * Full DEL then HEAD rebuild for n in 200..400 step 50.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, computeFileHash, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 full clear rebuild n200 400", () => {
	for (const n of [200, 250, 300, 350, 400]) {
		it(`n=${n}`, () => {
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
