/**
 * For i in 1..n: SWAP i to Di — diagonal fill of identity indices.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits SWAP diagonal pattern", () => {
	for (const n of [3, 5, 8]) {
		it(`n=${n}`, () => {
			const base = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
			const patch = Array.from(
				{ length: n },
				(_, i) => `SWAP ${i + 1}.=${i + 1}:\n+D${i + 1}`,
			).join("\n");
			const { text } = applyEdits(base, parsePatch(patch).edits);
			expect(text.split("\n")).toEqual(Array.from({ length: n }, (_, i) => `D${i + 1}`));
		});
	}
});
