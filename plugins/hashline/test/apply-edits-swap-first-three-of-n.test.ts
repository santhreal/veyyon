/**
 * SWAP first three lines of files n=3..7 to single X.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits SWAP first three of n", () => {
	for (const n of [3, 4, 5, 6, 7]) {
		it(`n=${n}`, () => {
			const base = Array.from({ length: n }, (_, i) => `L${i + 1}`);
			const { text: out } = applyEdits(base.join("\n"), parsePatch("SWAP 1.=3:\n+X").edits);
			const want = ["X", ...base.slice(3)].join("\n");
			expect(out).toBe(want);
		});
	}
});
