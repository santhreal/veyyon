/**
 * Past 5000 pure suite: continue SQLite-depth exact contracts.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, computeFileHash, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 5000 continue depth", () => {
	it("hash changes on any content edit", () => {
		const base = "keep\nthis";
		const h0 = computeFileHash(base);
		for (const patch of ["DEL 1", "SWAP 2.=2:\n+X", "INS.HEAD:\n+H", "INS.TAIL:\n+T"]) {
			const { text } = applyEdits(base, parsePatch(patch).edits);
			expect(computeFileHash(text)).not.toBe(h0);
		}
	});

	for (const n of [50, 100, 200]) {
		it(`n=${n} full clear and rebuild`, () => {
			const base = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
			const empty = applyEdits(base, parsePatch(`DEL 1.=${n}`).edits).text;
			expect(empty).toBe("");
			const rows = Array.from({ length: n }, (_, i) => `+L${i + 1}`).join("\n");
			const back = applyEdits(empty, parsePatch(`INS.HEAD:\n${rows}`).edits).text;
			expect(back).toBe(base);
		});
	}
});
