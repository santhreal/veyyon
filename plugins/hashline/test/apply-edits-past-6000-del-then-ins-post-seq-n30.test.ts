/**
 * Sequential DEL then INS.POST on renumbered file for n=30.
 * Why: after delete, line numbers shift; sequential ops use live indices.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 DEL then INS POST seq n30", () => {
	const n = 30;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let del = 1; del <= n; del++) {
		it(`DEL ${del} then POST 1`, () => {
			const mid = applyEdits(base, parsePatch(`DEL ${del}`).edits).text;
			const out = applyEdits(mid, parsePatch("INS.POST 1:\n+X").edits).text.split("\n");
			const afterDel = lines.filter((_, i) => i + 1 !== del);
			expect(out).toEqual([afterDel[0]!, "X", ...afterDel.slice(1)]);
		});
	}
});
