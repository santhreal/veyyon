/**
 * INS.TAIL k rows from empty for k=1..10.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.TAIL from empty k=1..10", () => {
	for (const k of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
		it(`k=${k}`, () => {
			const body = Array.from({ length: k }, (_, i) => `+R${i}`).join("\n");
			const { text } = applyEdits("", parsePatch(`INS.TAIL:\n${body}`).edits);
			expect(text).toBe(Array.from({ length: k }, (_, i) => `R${i}`).join("\n"));
		});
	}
});
