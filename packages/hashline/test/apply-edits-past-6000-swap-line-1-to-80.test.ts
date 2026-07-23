/**
 * SWAP every line 1..80 on n=80: exact body + firstChangedLine.
 * Why: full-file single-line replace grid past the 50-line band.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 SWAP line 1 to 80", () => {
	const n = 80;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let i = 1; i <= n; i++) {
		it(`SWAP ${i}`, () => {
			const { text, firstChangedLine } = applyEdits(base, parsePatch(`SWAP ${i}.=${i}:\n+X${i}`).edits);
			const out = text.split("\n");
			expect(out).toHaveLength(n);
			expect(out[i - 1]).toBe(`X${i}`);
			for (let j = 0; j < n; j++) {
				if (j !== i - 1) expect(out[j]).toBe(`L${j + 1}`);
			}
			expect(firstChangedLine).toBe(i);
		});
	}
});
