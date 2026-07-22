/**
 * INS.HEAD then DEL original indices on n=50: concurrent originals still target pre-insert lines.
 * Why: original-index model must not shift deletes when HEAD insert coexists in multi-hunk.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 INS HEAD then DEL original indices n50", () => {
	const n = 50;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let del = 1; del <= n; del++) {
		it(`HEAD + DEL original ${del}`, () => {
			const patch = `INS.HEAD:\n+H\nDEL ${del}`;
			const out = applyEdits(base, parsePatch(patch).edits).text.split("\n");
			// DEL targets original line del; HEAD inserts before all original lines
			const expected = ["H", ...lines.filter((_, i) => i + 1 !== del)];
			expect(out).toEqual(expected);
		});
	}

	it("HEAD + DEL all originals empties body leaves H", () => {
		const dels = Array.from({ length: n }, (_, i) => `DEL ${i + 1}`).join("\n");
		const out = applyEdits(base, parsePatch(`INS.HEAD:\n+H\n${dels}`).edits).text;
		expect(out).toBe("H");
	});
});
