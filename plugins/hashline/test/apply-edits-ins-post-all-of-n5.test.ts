/**
 * INS.POST after every line of 5-line file.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.POST all of n=5", () => {
	const base = ["a", "b", "c", "d", "e"];
	const text = base.join("\n");
	for (let i = 1; i <= 5; i++) {
		it(`POST ${i}`, () => {
			const { text: out } = applyEdits(text, parsePatch(`INS.POST ${i}:\n+X`).edits);
			const want = [...base];
			want.splice(i, 0, "X");
			expect(out).toBe(want.join("\n"));
		});
	}
});
