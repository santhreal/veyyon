/**
 * formatInsertHeader round-trip for PRE/POST lines 1..6.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, formatInsertHeader, parsePatch } from "@veyyon/hashline";

describe("formatInsertHeader PRE/POST round-trip n=6", () => {
	const base = ["a", "b", "c", "d", "e", "f"];
	const text = base.join("\n");
	for (let i = 1; i <= 6; i++) {
		it(`POST ${i}`, () => {
			const h = formatInsertHeader({ kind: "after_anchor", anchor: { line: i } });
			const { text: out } = applyEdits(text, parsePatch(`${h}\n+X`).edits);
			const want = [...base];
			want.splice(i, 0, "X");
			expect(out).toBe(want.join("\n"));
		});
		it(`PRE ${i}`, () => {
			const h = formatInsertHeader({ kind: "before_anchor", anchor: { line: i } });
			const { text: out } = applyEdits(text, parsePatch(`${h}\n+X`).edits);
			const want = [...base];
			want.splice(i - 1, 0, "X");
			expect(out).toBe(want.join("\n"));
		});
	}
});
