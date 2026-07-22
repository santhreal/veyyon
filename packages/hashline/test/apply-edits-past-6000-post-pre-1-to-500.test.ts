/**
 * INS.POST / INS.PRE at every anchor 1..500 on n=500.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 POST PRE 1 to 500", () => {
	const n = 500;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let a = 1; a <= n; a++) {
		it(`POST ${a}`, () => {
			const { text, firstChangedLine } = applyEdits(
				base,
				parsePatch(`INS.POST ${a}:\n+P`).edits,
			);
			expect(text.split("\n")[a]).toBe("P");
			expect(firstChangedLine).toBe(a);
		});

		it(`PRE ${a}`, () => {
			const { text, firstChangedLine } = applyEdits(
				base,
				parsePatch(`INS.PRE ${a}:\n+R`).edits,
			);
			expect(text.split("\n")[a - 1]).toBe("R");
			expect(firstChangedLine).toBe(a);
		});
	}
});
