/**
 * Shrink lines 2..=n-1 of n-line file to single X for n=4..8.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits shrink middle of n", () => {
	for (const n of [4, 5, 6, 7, 8]) {
		it(`n=${n}`, () => {
			const base = Array.from({ length: n }, (_, i) => `L${i + 1}`);
			const { text: out } = applyEdits(base.join("\n"), parsePatch(`SWAP 2.=${n - 1}:\n+X`).edits);
			expect(out).toBe(`L1\nX\nL${n}`);
		});
	}
});
