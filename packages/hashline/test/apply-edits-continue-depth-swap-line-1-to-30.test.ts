/**
 * SWAP single line i for i=1..30 on n=30 file: that line becomes Xi.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits continue depth SWAP line 1 to 30", () => {
	const n = 30;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let i = 1; i <= n; i++) {
		it(`SWAP ${i}`, () => {
			const { text } = applyEdits(
				base,
				parsePatch(`SWAP ${i}.=${i}:\n+X${i}`).edits,
			);
			const out = text.split("\n");
			expect(out).toHaveLength(n);
			expect(out[i - 1]).toBe(`X${i}`);
		});
	}
});
