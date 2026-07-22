/**
 * Multi-hunk SWAP every line to the same constant body: all lines equal.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits SWAP all lines to same body", () => {
	for (const n of [3, 5, 10]) {
		it(`n=${n}`, () => {
			const base = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
			const patch = Array.from(
				{ length: n },
				(_, i) => `SWAP ${i + 1}.=${i + 1}:\n+SAME`,
			).join("\n");
			const { text } = applyEdits(base, parsePatch(patch).edits);
			expect(text.split("\n")).toEqual(Array.from({ length: n }, () => "SAME"));
		});
	}
});
