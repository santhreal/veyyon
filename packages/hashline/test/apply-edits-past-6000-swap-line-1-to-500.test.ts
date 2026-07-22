/**
 * SWAP every line 1..500 on n=500.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 SWAP line 1 to 500", () => {
	const n = 500;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let i = 1; i <= n; i++) {
		it(`SWAP ${i}`, () => {
			const { text, firstChangedLine } = applyEdits(
				base,
				parsePatch(`SWAP ${i}.=${i}:\n+X${i}`).edits,
			);
			expect(text.split("\n")[i - 1]).toBe(`X${i}`);
			expect(firstChangedLine).toBe(i);
		});
	}
});
