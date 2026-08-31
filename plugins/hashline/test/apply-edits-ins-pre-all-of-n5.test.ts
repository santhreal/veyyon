/**
 * INS.PRE before every line of 5-line file.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.PRE all of n=5", () => {
	const base = ["a", "b", "c", "d", "e"];
	const text = base.join("\n");
	for (let i = 1; i <= 5; i++) {
		it(`PRE ${i}`, () => {
			const { text: out } = applyEdits(text, parsePatch(`INS.PRE ${i}:\n+X`).edits);
			const want = [...base];
			want.splice(i - 1, 0, "X");
			expect(out).toBe(want.join("\n"));
		});
	}
});
