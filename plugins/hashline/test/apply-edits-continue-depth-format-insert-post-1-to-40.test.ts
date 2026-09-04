/**
 * formatInsertHeader after_anchor → parse → apply for lines 1..40 on n=40.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, formatInsertHeader, parsePatch } from "@veyyon/hashline";

describe("applyEdits continue depth format insert POST 1 to 40", () => {
	const n = 40;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let i = 1; i <= n; i++) {
		it(`INS.POST ${i}`, () => {
			const h = formatInsertHeader({ kind: "after_anchor", anchor: { line: i } });
			const { text } = applyEdits(base, parsePatch(`${h}\n+X`).edits);
			expect(text.split("\n").length).toBe(n + 1);
			expect(text.split("\n")[i]).toBe("X");
		});
	}
});
