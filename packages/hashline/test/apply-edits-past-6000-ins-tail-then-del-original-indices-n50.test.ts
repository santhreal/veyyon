/**
 * INS.TAIL + DEL original indices concurrent on n=50.
 * Why: TAIL insert must not shift original-line deletes.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 INS TAIL then DEL original indices n50", () => {
	const n = 50;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let del = 1; del <= n; del++) {
		it(`TAIL + DEL original ${del}`, () => {
			const out = applyEdits(base, parsePatch(`INS.TAIL:\n+T\nDEL ${del}`).edits).text.split("\n");
			const expected = [...lines.filter((_, i) => i + 1 !== del), "T"];
			expect(out).toEqual(expected);
		});
	}
});
