/**
 * INS.PRE + DEL same original line concurrent on n=40.
 * Why: PRE inserts before original; DEL removes original; PRE body must remain.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 PRE then DEL same line n40", () => {
	const n = 40;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let a = 1; a <= n; a++) {
		it(`PRE+DEL ${a}`, () => {
			const out = applyEdits(base, parsePatch(`INS.PRE ${a}:\n+P\nDEL ${a}`).edits).text.split("\n");
			const expected = [...lines.slice(0, a - 1), "P", ...lines.slice(a)];
			expect(out).toEqual(expected);
		});
	}
});
