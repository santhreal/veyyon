/**
 * For each n in 1..20: SWAP every line to N{i} in one patch.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits batch property SWAP every line 1 to n", () => {
	for (let n = 1; n <= 20; n++) {
		it(`n=${n}`, () => {
			const base = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
			const patch = Array.from(
				{ length: n },
				(_, i) => `SWAP ${i + 1}.=${i + 1}:\n+N${i + 1}`,
			).join("\n");
			const { text } = applyEdits(base, parsePatch(patch).edits);
			expect(text.split("\n")).toEqual(Array.from({ length: n }, (_, i) => `N${i + 1}`));
		});
	}
});
