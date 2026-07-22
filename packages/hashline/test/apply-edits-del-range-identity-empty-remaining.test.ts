/**
 * DEL 1.=n on n-line file always yields empty string.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL full file always empty", () => {
	for (const n of [1, 2, 3, 5, 10, 20, 50, 100]) {
		it(`n=${n}`, () => {
			const base = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
			const patch = n === 1 ? "DEL 1" : `DEL 1.=${n}`;
			expect(applyEdits(base, parsePatch(patch).edits).text).toBe("");
		});
	}
});
