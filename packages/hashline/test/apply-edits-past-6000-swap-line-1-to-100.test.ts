/**
 * SWAP every line 1..100 on n=100: exact body + firstChangedLine.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 SWAP line 1 to 100", () => {
	const n = 100;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let i = 1; i <= n; i++) {
		it(`SWAP ${i}`, () => {
			const { text, firstChangedLine } = applyEdits(
				base,
				parsePatch(`SWAP ${i}.=${i}:\n+X${i}`).edits,
			);
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
