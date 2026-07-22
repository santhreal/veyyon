/**
 * Expand every line of 4-line file to three lines.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits expand each of 4 to 3", () => {
	const base = ["a", "b", "c", "d"];
	const text = base.join("\n");
	for (let pos = 1; pos <= 4; pos++) {
		it(`pos=${pos}`, () => {
			const { text: out } = applyEdits(
				text,
				parsePatch(`SWAP ${pos}.=${pos}:\n+X\n+Y\n+Z`).edits,
			);
			const want = [...base.slice(0, pos - 1), "X", "Y", "Z", ...base.slice(pos)];
			expect(out).toBe(want.join("\n"));
		});
	}
});
