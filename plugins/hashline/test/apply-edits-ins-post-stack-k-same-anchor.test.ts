/**
 * k sequential INS.POST on the same original anchor in one multi-hunk patch
 * stacks inserts in order after that line.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.POST stack k same anchor", () => {
	for (const k of [2, 3, 5, 8]) {
		it(`k=${k} after line 2`, () => {
			const base = "a\nb\nc";
			const hunks = Array.from({ length: k }, (_, i) => `INS.POST 2:\n+S${i}`).join("\n");
			const { text } = applyEdits(base, parsePatch(hunks).edits);
			const out = text.split("\n");
			expect(out[0]).toBe("a");
			expect(out[1]).toBe("b");
			for (let i = 0; i < k; i++) {
				expect(out[2 + i]).toBe(`S${i}`);
			}
			expect(out[2 + k]).toBe("c");
			expect(out.length).toBe(3 + k);
		});
	}
});
