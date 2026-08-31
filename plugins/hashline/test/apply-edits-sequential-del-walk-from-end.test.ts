/**
 * Sequential DEL of last line until empty: exact intermediate lengths.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits sequential DEL walk from end", () => {
	for (const n of [3, 5, 8]) {
		it(`n=${n}`, () => {
			let t = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
			for (let left = n; left >= 1; left--) {
				expect(t.split("\n")).toHaveLength(left);
				t = applyEdits(t, parsePatch(`DEL ${left}`).edits).text;
			}
			expect(t).toBe("");
		});
	}
});
