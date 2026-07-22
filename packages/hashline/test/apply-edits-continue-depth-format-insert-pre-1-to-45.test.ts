/**
 * formatInsertHeader before_anchor → parse → apply for lines 1..45 on n=45.
 * Crosses 5000 pure suite tests.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, formatInsertHeader, parsePatch } from "@veyyon/hashline";

describe("applyEdits continue depth format insert PRE 1 to 45", () => {
	const n = 45;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let i = 1; i <= n; i++) {
		it(`INS.PRE ${i}`, () => {
			const h = formatInsertHeader({ kind: "before_anchor", anchor: { line: i } });
			const { text } = applyEdits(base, parsePatch(`${h}\n+X`).edits);
			expect(text.split("\n").length).toBe(n + 1);
			expect(text.split("\n")[i - 1]).toBe("X");
		});
	}
});
