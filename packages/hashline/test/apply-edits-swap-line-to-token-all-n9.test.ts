/**
 * SWAP each line of 9-line file to Ti.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits SWAP each of 9 to Ti", () => {
	const base = Array.from({ length: 9 }, (_, i) => `L${i + 1}`);
	const text = base.join("\n");
	for (let i = 1; i <= 9; i++) {
		it(`i=${i}`, () => {
			const { text: out } = applyEdits(
				text,
				parsePatch(`SWAP ${i}.=${i}:\n+T${i}`).edits,
			);
			const want = base.map((v, j) => (j + 1 === i ? `T${i}` : v));
			expect(out).toBe(want.join("\n"));
		});
	}
});
