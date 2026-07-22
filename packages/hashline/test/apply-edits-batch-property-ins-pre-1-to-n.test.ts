/**
 * For each n in 2..15: INS.PRE on every line 1..n adds n lines.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits batch property INS.PRE 1 to n", () => {
	for (let n = 2; n <= 15; n++) {
		it(`n=${n}`, () => {
			const base = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
			const patch = Array.from({ length: n }, (_, i) => `INS.PRE ${i + 1}:\n+X`).join("\n");
			const { text } = applyEdits(base, parsePatch(patch).edits);
			expect(text.split("\n").length).toBe(n * 2);
			expect(text.split("\n").filter(l => l === "X").length).toBe(n);
		});
	}
});
