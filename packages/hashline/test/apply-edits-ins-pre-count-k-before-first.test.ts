/**
 * INS.PRE 1 with k body rows prepends k lines.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.PRE 1 with k rows", () => {
	for (const k of [1, 2, 3, 4, 5, 6, 7, 8]) {
		it(`k=${k}`, () => {
			const body = Array.from({ length: k }, (_, i) => `+R${i}`).join("\n");
			const { text } = applyEdits("BODY", parsePatch(`INS.PRE 1:\n${body}`).edits);
			const mid = Array.from({ length: k }, (_, i) => `R${i}`);
			expect(text).toBe([...mid, "BODY"].join("\n"));
		});
	}
});
