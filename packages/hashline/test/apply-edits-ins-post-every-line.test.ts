/**
 * INS.POST after every line of a 6-line file: exact insertion positions.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, formatInsertHeader, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.POST every line of 6-line file", () => {
	const base = ["a", "b", "c", "d", "e", "f"];
	const text = base.join("\n");

	for (let i = 1; i <= base.length; i++) {
		it(`INS.POST ${i} inserts X after line ${i}`, () => {
			const h = formatInsertHeader({ kind: "after_anchor", anchor: { line: i } });
			const { text: out } = applyEdits(text, parsePatch(`${h}\n+X`).edits);
			const want = [...base];
			want.splice(i, 0, "X");
			expect(out).toBe(want.join("\n"));
		});
	}

	for (let i = 1; i <= base.length; i++) {
		it(`INS.PRE ${i} inserts X before line ${i}`, () => {
			const h = formatInsertHeader({ kind: "before_anchor", anchor: { line: i } });
			const { text: out } = applyEdits(text, parsePatch(`${h}\n+X`).edits);
			const want = [...base];
			want.splice(i - 1, 0, "X");
			expect(out).toBe(want.join("\n"));
		});
	}
});
