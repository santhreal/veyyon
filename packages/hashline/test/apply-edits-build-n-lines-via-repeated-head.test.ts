/**
 * Build an n-line file from empty via n sequential INS.HEAD (reverse order).
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

function apply(text: string, patch: string): string {
	return applyEdits(text, parsePatch(patch).edits).text;
}

describe("applyEdits build n lines via repeated HEAD", () => {
	for (const n of [1, 5, 10, 20]) {
		it(`n=${n} reverse insert order`, () => {
			let t = "";
			for (let i = n; i >= 1; i--) {
				t = apply(t, `INS.HEAD:\n+L${i}`);
			}
			expect(t.split("\n")).toEqual(Array.from({ length: n }, (_, i) => `L${i + 1}`));
		});
	}
});
