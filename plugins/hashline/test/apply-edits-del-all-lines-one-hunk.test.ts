/**
 * DEL 1.=n of n-line file yields empty.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL entire file", () => {
	for (const n of [1, 2, 3, 5, 8, 12]) {
		it(`n=${n}`, () => {
			const text = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
			const header = n === 1 ? "DEL 1" : `DEL 1.=${n}`;
			const { text: out } = applyEdits(text, parsePatch(header).edits);
			expect(out).toBe("");
		});
	}
});
