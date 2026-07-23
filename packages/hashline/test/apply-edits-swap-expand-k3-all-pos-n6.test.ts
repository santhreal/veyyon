/**
 * Expand every position of 6-line file to 3 lines.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits expand each of 6 to 3", () => {
	const base = ["a", "b", "c", "d", "e", "f"];
	const text = base.join("\n");
	for (let pos = 1; pos <= 6; pos++) {
		it(`pos=${pos}`, () => {
			const { text: out } = applyEdits(text, parsePatch(`SWAP ${pos}.=${pos}:\n+X\n+Y\n+Z`).edits);
			const want = [...base.slice(0, pos - 1), "X", "Y", "Z", ...base.slice(pos)];
			expect(out).toBe(want.join("\n"));
		});
	}
});
