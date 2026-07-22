/**
 * SWAP last three lines of files n=3..7 to single X.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits SWAP last three of n", () => {
	for (const n of [3, 4, 5, 6, 7]) {
		it(`n=${n}`, () => {
			const base = Array.from({ length: n }, (_, i) => `L${i + 1}`);
			const start = n - 2;
			const { text: out } = applyEdits(
				base.join("\n"),
				parsePatch(`SWAP ${start}.=${n}:\n+X`).edits,
			);
			const want = [...base.slice(0, start - 1), "X"].join("\n");
			expect(out).toBe(want);
		});
	}
});
