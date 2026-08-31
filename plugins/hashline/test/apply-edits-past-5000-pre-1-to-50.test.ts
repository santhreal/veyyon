/**
 * INS.PRE on each anchor 1..50 of a 50-line file.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 5000 PRE 1 to 50", () => {
	const n = 50;
	const base = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");

	for (let a = 1; a <= n; a++) {
		it(`PRE ${a}`, () => {
			const { text } = applyEdits(base, parsePatch(`INS.PRE ${a}:\n+X`).edits);
			expect(text.split("\n").length).toBe(n + 1);
			expect(text.split("\n")[a - 1]).toBe("X");
		});
	}
});
