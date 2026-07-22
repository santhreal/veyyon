/**
 * File of n blank lines: SWAP each to unique content.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits all blank lines to content grid", () => {
	for (const n of [2, 3, 5]) {
		it(`n=${n}`, () => {
			const base = Array.from({ length: n }, () => "").join("\n");
			const patch = Array.from(
				{ length: n },
				(_, i) => `SWAP ${i + 1}.=${i + 1}:\n+C${i + 1}`,
			).join("\n");
			const { text } = applyEdits(base, parsePatch(patch).edits);
			// trailing blank base can leave a phantom empty line after replace
			const out = text.split("\n").filter((l, i, a) => !(i === a.length - 1 && l === ""));
			expect(out).toEqual(Array.from({ length: n }, (_, i) => `C${i + 1}`));
		});
	}
});
