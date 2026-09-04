/**
 * For each n in 2..15: INS.POST on every line 1..n-1 adds n-1 lines.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits batch property INS.POST 1 to n-1", () => {
	for (let n = 2; n <= 15; n++) {
		it(`n=${n}`, () => {
			const base = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
			const patch = Array.from({ length: n - 1 }, (_, i) => `INS.POST ${i + 1}:\n+X`).join("\n");
			const { text } = applyEdits(base, parsePatch(patch).edits);
			expect(text.split("\n").length).toBe(n + (n - 1));
			expect(text.split("\n").filter(l => l === "X").length).toBe(n - 1);
		});
	}
});
