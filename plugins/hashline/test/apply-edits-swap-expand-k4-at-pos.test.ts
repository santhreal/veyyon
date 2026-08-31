/**
 * Expand position of 5-line file to 4 lines for each pos.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits expand to 4 at each pos of 5", () => {
	const base = ["a", "b", "c", "d", "e"];
	const text = base.join("\n");
	for (let pos = 1; pos <= 5; pos++) {
		it(`pos=${pos}`, () => {
			const { text: out } = applyEdits(text, parsePatch(`SWAP ${pos}.=${pos}:\n+W\n+X\n+Y\n+Z`).edits);
			const want = [...base.slice(0, pos - 1), "W", "X", "Y", "Z", ...base.slice(pos)];
			expect(out).toBe(want.join("\n"));
		});
	}
});
