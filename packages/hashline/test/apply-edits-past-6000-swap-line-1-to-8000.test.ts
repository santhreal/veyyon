/**
 * SWAP every line 1..8000 on n=8000.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 SWAP line 1 to 8000", () => {
	const n = 8000;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let i = 1; i <= n; i++) {
		it(`SWAP ${i}`, () => {
			const { text, firstChangedLine } = applyEdits(base, parsePatch(`SWAP ${i}.=${i}:\n+X${i}`).edits);
			expect(text.split("\n")[i - 1]).toBe(`X${i}`);
			expect(firstChangedLine).toBe(i);
		});
	}
});
