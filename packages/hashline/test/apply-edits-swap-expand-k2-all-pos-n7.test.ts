/**
 * Expand every position of 7-line file to 2 lines.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits expand each of 7 to 2", () => {
	const base = ["a", "b", "c", "d", "e", "f", "g"];
	const text = base.join("\n");
	for (let pos = 1; pos <= 7; pos++) {
		it(`pos=${pos}`, () => {
			const { text: out } = applyEdits(text, parsePatch(`SWAP ${pos}.=${pos}:\n+X\n+Y`).edits);
			const want = [...base.slice(0, pos - 1), "X", "Y", ...base.slice(pos)];
			expect(out).toBe(want.join("\n"));
		});
	}
});
