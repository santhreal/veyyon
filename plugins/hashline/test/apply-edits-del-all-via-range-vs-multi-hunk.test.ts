/**
 * DEL 1.=n single range equals multi-hunk DEL 1..n for full clear.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL all via range vs multi-hunk", () => {
	for (const n of [2, 3, 5, 8]) {
		it(`n=${n}`, () => {
			const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
			const base = lines.join("\n");
			const range = applyEdits(base, parsePatch(`DEL 1.=${n}`).edits).text;
			const multi = applyEdits(
				base,
				parsePatch(Array.from({ length: n }, (_, i) => `DEL ${i + 1}`).join("\n")).edits,
			).text;
			expect(range).toBe("");
			expect(multi).toBe("");
			expect(range).toBe(multi);
		});
	}
});
