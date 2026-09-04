/**
 * INS.POST after every line in one patch: doubles length with inserts after each.
 * Anchors address original file.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.POST all lines one patch", () => {
	for (const n of [2, 3, 5]) {
		it(`n=${n}`, () => {
			const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
			const base = lines.join("\n");
			const patch = Array.from({ length: n }, (_, i) => `INS.POST ${i + 1}:\n+X${i + 1}`).join("\n");
			const { text } = applyEdits(base, parsePatch(patch).edits);
			const out = text.split("\n");
			// Expected interleave: L1 X1 L2 X2 ...
			const want: string[] = [];
			for (let i = 0; i < n; i++) {
				want.push(lines[i]!);
				want.push(`X${i + 1}`);
			}
			expect(out).toEqual(want);
		});
	}
});
