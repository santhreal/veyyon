/**
 * Replace every line of n-file with its 1-based index string in one patch.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits continue depth replace all with numbered", () => {
	for (const n of [5, 10, 15, 25]) {
		it(`n=${n}`, () => {
			const base = Array.from({ length: n }, () => "x").join("\n");
			const patch = Array.from(
				{ length: n },
				(_, i) => `SWAP ${i + 1}.=${i + 1}:\n+${i + 1}`,
			).join("\n");
			const { text } = applyEdits(base, parsePatch(patch).edits);
			expect(text.split("\n")).toEqual(Array.from({ length: n }, (_, i) => String(i + 1)));
		});
	}
});
