/**
 * INS.POST after every line of a 4-line file.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, formatInsertHeader, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.POST all positions n=4", () => {
	const base = ["a", "b", "c", "d"];
	const text = base.join("\n");
	for (let i = 1; i <= 4; i++) {
		it(`POST ${i}`, () => {
			const h = formatInsertHeader({ kind: "after_anchor", anchor: { line: i } });
			const { text: out } = applyEdits(text, parsePatch(`${h}\n+X`).edits);
			const want = [...base];
			want.splice(i, 0, "X");
			expect(out).toBe(want.join("\n"));
		});
	}
});
