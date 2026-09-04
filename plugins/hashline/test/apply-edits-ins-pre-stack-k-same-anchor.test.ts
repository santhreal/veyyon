/**
 * k sequential INS.PRE on the same original anchor stack before that line.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.PRE stack k same anchor", () => {
	for (const k of [2, 3, 5, 8]) {
		it(`k=${k} before line 2`, () => {
			const base = "a\nb\nc";
			const hunks = Array.from({ length: k }, (_, i) => `INS.PRE 2:\n+S${i}`).join("\n");
			const { text } = applyEdits(base, parsePatch(hunks).edits);
			const out = text.split("\n");
			expect(out[0]).toBe("a");
			for (let i = 0; i < k; i++) {
				expect(out[1 + i]).toBe(`S${i}`);
			}
			expect(out[1 + k]).toBe("b");
			expect(out[2 + k]).toBe("c");
			expect(out.length).toBe(3 + k);
		});
	}
});
