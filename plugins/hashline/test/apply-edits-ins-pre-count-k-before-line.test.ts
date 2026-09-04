/**
 * Single INS.PRE with k body rows before line 2 of a 3-line file.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.PRE k rows before line 2", () => {
	for (const k of [1, 2, 3, 4, 5, 6, 7, 8]) {
		it(`k=${k}`, () => {
			const body = Array.from({ length: k }, (_, i) => `+R${i}`).join("\n");
			const { text } = applyEdits("A\nB\nC", parsePatch(`INS.PRE 2:\n${body}`).edits);
			const mid = Array.from({ length: k }, (_, i) => `R${i}`);
			expect(text).toBe(["A", ...mid, "B", "C"].join("\n"));
		});
	}
});
