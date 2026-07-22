/**
 * INS.PRE and INS.POST same original line concurrent on n=40.
 * Why: before and after same anchor must both land around original line.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 PRE and POST same line n40", () => {
	const n = 40;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let a = 1; a <= n; a++) {
		it(`PRE+POST ${a}`, () => {
			const out = applyEdits(
				base,
				parsePatch(`INS.PRE ${a}:\n+B\nINS.POST ${a}:\n+A`).edits,
			).text.split("\n");
			const expected = [...lines.slice(0, a - 1), "B", lines[a - 1]!, "A", ...lines.slice(a)];
			expect(out).toEqual(expected);
		});
	}
});
