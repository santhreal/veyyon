/**
 * SWAP 1.=n of n-line file to single X in one hunk.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits SWAP entire file to X", () => {
	for (const n of [1, 2, 3, 5, 8, 12]) {
		it(`n=${n}`, () => {
			const text = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
			const { text: out } = applyEdits(text, parsePatch(`SWAP 1.=${n}:\n+X`).edits);
			expect(out).toBe("X");
		});
	}
});
