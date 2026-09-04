/**
 * One patch: DEL all even lines and SWAP odd lines to markers.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits multi-hunk DEL evens and SWAP odds", () => {
	for (const n of [4, 6, 8]) {
		it(`n=${n}`, () => {
			const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
			const base = lines.join("\n");
			const hunks: string[] = [];
			for (let i = 1; i <= n; i++) {
				if (i % 2 === 0) hunks.push(`DEL ${i}`);
				else hunks.push(`SWAP ${i}.=${i}:\n+O${i}`);
			}
			const { text } = applyEdits(base, parsePatch(hunks.join("\n")).edits);
			// remaining are odds only, all swapped
			const want = Array.from({ length: n }, (_, i) => i + 1)
				.filter(i => i % 2 === 1)
				.map(i => `O${i}`);
			expect(text.split("\n")).toEqual(want);
		});
	}
});
