/**
 * INS.POST + DEL same original line concurrent on n=40.
 * Why: delete original and insert-after must leave POST body at that position.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 POST then DEL same line n40", () => {
	const n = 40;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let a = 1; a <= n; a++) {
		it(`POST+DEL ${a}`, () => {
			const out = applyEdits(base, parsePatch(`INS.POST ${a}:\n+P\nDEL ${a}`).edits).text.split("\n");
			const expected = [...lines.slice(0, a - 1), "P", ...lines.slice(a)];
			expect(out).toEqual(expected);
		});
	}
});
