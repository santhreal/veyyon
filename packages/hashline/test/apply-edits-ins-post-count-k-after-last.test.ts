/**
 * INS.POST last-line with k body rows appends k lines.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.POST last with k rows", () => {
	for (const k of [1, 2, 3, 4, 5, 6, 7, 8]) {
		it(`k=${k}`, () => {
			const body = Array.from({ length: k }, (_, i) => `+R${i}`).join("\n");
			const { text } = applyEdits("A\nB", parsePatch(`INS.POST 2:\n${body}`).edits);
			const mid = Array.from({ length: k }, (_, i) => `R${i}`);
			expect(text).toBe(["A", "B", ...mid].join("\n"));
		});
	}
});
