/**
 * Expand every position of 8-line file to 2 lines.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits expand each of 8 to 2", () => {
	const base = Array.from({ length: 8 }, (_, i) => `L${i + 1}`);
	const text = base.join("\n");
	for (let pos = 1; pos <= 8; pos++) {
		it(`pos=${pos}`, () => {
			const { text: out } = applyEdits(text, parsePatch(`SWAP ${pos}.=${pos}:\n+A\n+B`).edits);
			const want = [...base.slice(0, pos - 1), "A", "B", ...base.slice(pos)];
			expect(out).toBe(want.join("\n"));
		});
	}
});
