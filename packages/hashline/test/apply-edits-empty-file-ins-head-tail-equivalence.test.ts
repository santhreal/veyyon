/**
 * On empty file, INS.HEAD and INS.TAIL with same body produce identical text.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits empty file HEAD/TAIL equivalence", () => {
	for (const k of [1, 2, 5, 10]) {
		it(`k=${k} rows HEAD equals TAIL on empty`, () => {
			const rows = Array.from({ length: k }, (_, i) => `+R${i}`).join("\n");
			const head = applyEdits("", parsePatch(`INS.HEAD:\n${rows}`).edits).text;
			const tail = applyEdits("", parsePatch(`INS.TAIL:\n${rows}`).edits).text;
			expect(head).toBe(tail);
			expect(head.split("\n")).toEqual(Array.from({ length: k }, (_, i) => `R${i}`));
		});
	}
});
