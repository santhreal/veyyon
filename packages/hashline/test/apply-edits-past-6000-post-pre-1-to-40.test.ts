/**
 * INS.POST / INS.PRE at every anchor 1..40 on n=40 file: exact splice position.
 * Why: anchor-relative insert must not shift wrong sibling lines.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 POST PRE 1 to 40", () => {
	const n = 40;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let a = 1; a <= n; a++) {
		it(`INS.POST ${a}`, () => {
			const { text, firstChangedLine } = applyEdits(
				base,
				parsePatch(`INS.POST ${a}:\n+P`).edits,
			);
			const out = text.split("\n");
			expect(out).toHaveLength(n + 1);
			expect(out[a]).toBe("P");
			expect(out[a - 1]).toBe(`L${a}`);
			// firstChangedLine for POST is the anchor line (insert after)
			expect(firstChangedLine).toBe(a);
		});

		it(`INS.PRE ${a}`, () => {
			const { text, firstChangedLine } = applyEdits(
				base,
				parsePatch(`INS.PRE ${a}:\n+R`).edits,
			);
			const out = text.split("\n");
			expect(out).toHaveLength(n + 1);
			expect(out[a - 1]).toBe("R");
			expect(out[a]).toBe(`L${a}`);
			expect(firstChangedLine).toBe(a);
		});
	}
});
