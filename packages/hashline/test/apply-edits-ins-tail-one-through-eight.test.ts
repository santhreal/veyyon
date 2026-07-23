/**
 * INS.TAIL with 1..8 body rows on empty and non-empty sources.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.TAIL 1..8 rows", () => {
	for (const k of [1, 2, 3, 4, 5, 6, 7, 8]) {
		it(`empty source k=${k}`, () => {
			const body = Array.from({ length: k }, (_, i) => `+R${i}`).join("\n");
			const { text } = applyEdits("", parsePatch(`INS.TAIL:\n${body}`).edits);
			expect(text).toBe(Array.from({ length: k }, (_, i) => `R${i}`).join("\n"));
		});
		it(`with body k=${k}`, () => {
			const body = Array.from({ length: k }, (_, i) => `+R${i}`).join("\n");
			const { text } = applyEdits("HEAD", parsePatch(`INS.TAIL:\n${body}`).edits);
			expect(text).toBe(["HEAD", ...Array.from({ length: k }, (_, i) => `R${i}`)].join("\n"));
		});
	}
});
