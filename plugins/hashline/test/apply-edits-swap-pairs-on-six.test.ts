/**
 * SWAP every pair of adjacent lines on a 6-line file to single X.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits SWAP adjacent pairs on 6 lines", () => {
	const base = ["1", "2", "3", "4", "5", "6"];
	const text = base.join("\n");
	for (let start = 1; start <= 5; start++) {
		const end = start + 1;
		it(`SWAP ${start}.=${end}`, () => {
			const { text: out } = applyEdits(text, parsePatch(`SWAP ${start}.=${end}:\n+X`).edits);
			const want = [...base];
			want.splice(start - 1, 2, "X");
			expect(out).toBe(want.join("\n"));
		});
	}
});
