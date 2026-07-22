/**
 * Expand every position of 6-line file to two lines.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits expand each of 6 to 2", () => {
	const base = ["1", "2", "3", "4", "5", "6"];
	const text = base.join("\n");
	for (let pos = 1; pos <= 6; pos++) {
		it(`pos=${pos}`, () => {
			const { text: out } = applyEdits(
				text,
				parsePatch(`SWAP ${pos}.=${pos}:\n+A\n+B`).edits,
			);
			const want = [...base.slice(0, pos - 1), "A", "B", ...base.slice(pos)];
			expect(out).toBe(want.join("\n"));
		});
	}
});
