/**
 * Full DEL 1.=n then HEAD rebuild for n in scale set; hash equality after rebuild.
 * Why: scale clear/rebuild beyond 300 past-6000 smoke.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, computeFileHash, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 full clear rebuild scale", () => {
	for (const n of [40, 80, 120, 250, 400, 500]) {
		it(`n=${n} DEL all then HEAD rebuild hash-stable`, () => {
			const base = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
			const h0 = computeFileHash(base);
			const empty = applyEdits(base, parsePatch(`DEL 1.=${n}`).edits).text;
			expect(empty).toBe("");
			expect(computeFileHash(empty)).not.toBe(h0);
			const rows = Array.from({ length: n }, (_, i) => `+L${i + 1}`).join("\n");
			const back = applyEdits(empty, parsePatch(`INS.HEAD:\n${rows}`).edits).text;
			expect(back).toBe(base);
			expect(computeFileHash(back)).toBe(h0);
		});

		it(`n=${n} DEL all then TAIL rebuild`, () => {
			const base = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
			const empty = applyEdits(base, parsePatch(`DEL 1.=${n}`).edits).text;
			const rows = Array.from({ length: n }, (_, i) => `+L${i + 1}`).join("\n");
			const back = applyEdits(empty, parsePatch(`INS.TAIL:\n${rows}`).edits).text;
			expect(back).toBe(base);
		});
	}
});
