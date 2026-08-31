/**
 * Single INS.POST with k body rows after line 1 of a 2-line file.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.POST k rows after line 1", () => {
	for (const k of [1, 2, 3, 4, 5, 6, 7, 8]) {
		it(`k=${k}`, () => {
			const body = Array.from({ length: k }, (_, i) => `+R${i}`).join("\n");
			const { text } = applyEdits("A\nZ", parsePatch(`INS.POST 1:\n${body}`).edits);
			const mid = Array.from({ length: k }, (_, i) => `R${i}`);
			expect(text).toBe(["A", ...mid, "Z"].join("\n"));
		});
	}
});
