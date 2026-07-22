/**
 * Build an n-line file from empty via n sequential INS.TAIL.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

function apply(text: string, patch: string): string {
	return applyEdits(text, parsePatch(patch).edits).text;
}

describe("applyEdits build n lines via repeated TAIL", () => {
	for (const n of [1, 5, 10, 20]) {
		it(`n=${n}`, () => {
			let t = "";
			for (let i = 1; i <= n; i++) {
				t = apply(t, `INS.TAIL:\n+L${i}`);
			}
			expect(t.split("\n")).toEqual(Array.from({ length: n }, (_, i) => `L${i + 1}`));
		});
	}
});
