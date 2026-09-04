/**
 * INS.HEAD / INS.TAIL of k rows for k=1..80 onto fixed 2-line base.
 * Why: body-row count must match insert length past the 60-row band.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 INS HEAD/TAIL k 1 to 80", () => {
	const base = "A\nB";

	for (let k = 1; k <= 80; k++) {
		it(`INS.HEAD k=${k}`, () => {
			const rows = Array.from({ length: k }, (_, i) => `+H${i + 1}`).join("\n");
			const { text, firstChangedLine } = applyEdits(base, parsePatch(`INS.HEAD:\n${rows}`).edits);
			const out = text.split("\n");
			expect(out).toHaveLength(2 + k);
			expect(out.slice(0, k)).toEqual(Array.from({ length: k }, (_, i) => `H${i + 1}`));
			expect(out.slice(k)).toEqual(["A", "B"]);
			expect(firstChangedLine).toBe(1);
		});

		it(`INS.TAIL k=${k}`, () => {
			const rows = Array.from({ length: k }, (_, i) => `+T${i + 1}`).join("\n");
			const { text } = applyEdits(base, parsePatch(`INS.TAIL:\n${rows}`).edits);
			const out = text.split("\n");
			expect(out).toHaveLength(2 + k);
			expect(out.slice(0, 2)).toEqual(["A", "B"]);
			expect(out.slice(2)).toEqual(Array.from({ length: k }, (_, i) => `T${i + 1}`));
		});
	}
});
