/**
 * n single-line SWAPs in one patch covering every line: all bodies land.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits many small SWAPs one patch", () => {
	for (const n of [2, 4, 8, 12]) {
		it(`n=${n} swap every line`, () => {
			const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
			const base = lines.join("\n");
			const patch = Array.from(
				{ length: n },
				(_, i) => `SWAP ${i + 1}.=${i + 1}:\n+N${i + 1}`,
			).join("\n");
			const { text } = applyEdits(base, parsePatch(patch).edits);
			expect(text.split("\n")).toEqual(Array.from({ length: n }, (_, i) => `N${i + 1}`));
		});
	}
});
