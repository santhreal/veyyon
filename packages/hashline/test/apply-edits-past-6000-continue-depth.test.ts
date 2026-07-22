/**
 * Past 6000 pure suite: continue SQLite-depth exact contracts.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 continue depth", () => {
	for (const n of [75, 150, 300]) {
		it(`n=${n} full DEL then HEAD rebuild`, () => {
			const base = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
			const empty = applyEdits(base, parsePatch(`DEL 1.=${n}`).edits).text;
			expect(empty).toBe("");
			const rows = Array.from({ length: n }, (_, i) => `+L${i + 1}`).join("\n");
			const back = applyEdits(empty, parsePatch(`INS.HEAD:\n${rows}`).edits).text;
			expect(back).toBe(base);
		});
	}
});
