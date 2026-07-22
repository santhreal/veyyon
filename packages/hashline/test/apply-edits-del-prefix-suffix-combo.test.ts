/**
 * Multi-hunk DEL first and last of n-line files.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL first and last", () => {
	for (const n of [2, 3, 5, 8]) {
		it(`n=${n}`, () => {
			const base = Array.from({ length: n }, (_, i) => `L${i + 1}`);
			const { text: out } = applyEdits(
				base.join("\n"),
				parsePatch(`DEL 1\nDEL ${n}`).edits,
			);
			const want = base.slice(1, -1).join("\n");
			expect(out).toBe(want);
		});
	}
});
