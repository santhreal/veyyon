/**
 * SWAP single line i for i=1..50 on n=50 file.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 5000 SWAP line 1 to 50", () => {
	const n = 50;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let i = 1; i <= n; i++) {
		it(`SWAP ${i}`, () => {
			const { text } = applyEdits(
				base,
				parsePatch(`SWAP ${i}.=${i}:\n+X${i}`).edits,
			);
			expect(text.split("\n")[i - 1]).toBe(`X${i}`);
			expect(text.split("\n")).toHaveLength(n);
		});
	}
});
