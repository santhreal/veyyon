/**
 * INS.PRE before every line of a 5-line file.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, formatInsertHeader, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.PRE every line of 5", () => {
	const base = ["a", "b", "c", "d", "e"];
	const text = base.join("\n");
	for (let i = 1; i <= 5; i++) {
		it(`PRE ${i}`, () => {
			const h = formatInsertHeader({ kind: "before_anchor", anchor: { line: i } });
			const { text: out } = applyEdits(text, parsePatch(`${h}\n+X`).edits);
			const want = [...base];
			want.splice(i - 1, 0, "X");
			expect(out).toBe(want.join("\n"));
		});
	}
});
