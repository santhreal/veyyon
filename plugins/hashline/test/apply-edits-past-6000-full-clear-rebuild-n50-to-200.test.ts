/**
 * Full DEL 1..=n then HEAD rebuild for n=50..200 step 10.
 * Why: clear+rebuild must restore exact bytes and hash.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, computeFileHash, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 full clear rebuild n50 to 200", () => {
	for (let n = 50; n <= 200; n += 10) {
		it(`n=${n}`, () => {
			const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
			const base = lines.join("\n");
			const h0 = computeFileHash(base);
			const empty = applyEdits(base, parsePatch(`DEL 1.=${n}`).edits).text;
			expect(empty).toBe("");
			const body = lines.map(l => `+${l}`).join("\n");
			const back = applyEdits(empty, parsePatch(`INS.HEAD:\n${body}`).edits).text;
			expect(back).toBe(base);
			expect(computeFileHash(back)).toBe(h0);
		});
	}
});
