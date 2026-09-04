/**
 * SWAP each line i of n-line files n=2..5 to token Ti.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits SWAP line i of n to Ti", () => {
	for (const n of [2, 3, 4, 5]) {
		const base = Array.from({ length: n }, (_, i) => `L${i + 1}`);
		const text = base.join("\n");
		for (let i = 1; i <= n; i++) {
			it(`n=${n} i=${i}`, () => {
				const { text: out } = applyEdits(text, parsePatch(`SWAP ${i}.=${i}:\n+T${i}`).edits);
				const want = base.map((v, j) => (j + 1 === i ? `T${i}` : v));
				expect(out).toBe(want.join("\n"));
			});
		}
	}
});
