/**
 * INS.PRE before every line in one patch: inserts before each original line.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.PRE all lines one patch", () => {
	for (const n of [2, 3, 5]) {
		it(`n=${n}`, () => {
			const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
			const base = lines.join("\n");
			const patch = Array.from({ length: n }, (_, i) => `INS.PRE ${i + 1}:\n+X${i + 1}`).join("\n");
			const { text } = applyEdits(base, parsePatch(patch).edits);
			const out = text.split("\n");
			const want: string[] = [];
			for (let i = 0; i < n; i++) {
				want.push(`X${i + 1}`);
				want.push(lines[i]!);
			}
			expect(out).toEqual(want);
		});
	}
});
