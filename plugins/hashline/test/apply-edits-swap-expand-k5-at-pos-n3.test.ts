/**
 * Expand each of 3 lines to 5 lines.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits expand each of 3 to 5", () => {
	const base = ["a", "b", "c"];
	const text = base.join("\n");
	for (let pos = 1; pos <= 3; pos++) {
		it(`pos=${pos}`, () => {
			const body = Array.from({ length: 5 }, (_, i) => `+E${i}`).join("\n");
			const { text: out } = applyEdits(text, parsePatch(`SWAP ${pos}.=${pos}:\n${body}`).edits);
			const mid = Array.from({ length: 5 }, (_, i) => `E${i}`);
			const want = [...base.slice(0, pos - 1), ...mid, ...base.slice(pos)];
			expect(out).toBe(want.join("\n"));
		});
	}
});
