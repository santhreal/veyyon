/**
 * Clear file twice via DEL+HEAD cycles: hash stable after each full rebuild.
 * Why: empty intermediate must not poison subsequent HEAD multi-row inserts.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, computeFileHash, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 double clear rebuild", () => {
	for (const n of [5, 10, 25, 50, 100]) {
		it(`n=${n} two clear-rebuild cycles`, () => {
			const base = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
			const h0 = computeFileHash(base);
			let t = base;
			for (let cycle = 0; cycle < 2; cycle++) {
				t = applyEdits(t, parsePatch(`DEL 1.=${n}`).edits).text;
				expect(t).toBe("");
				const rows = Array.from({ length: n }, (_, i) => `+L${i + 1}`).join("\n");
				t = applyEdits(t, parsePatch(`INS.HEAD:\n${rows}`).edits).text;
				expect(t).toBe(base);
				expect(computeFileHash(t)).toBe(h0);
			}
		});
	}
});
