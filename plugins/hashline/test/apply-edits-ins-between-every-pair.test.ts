/**
 * For each gap between n lines, INS.POST at i inserts between i and i+1.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS between every pair", () => {
	const n = 6;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let i = 1; i < n; i++) {
		it(`INS.POST ${i} inserts between L${i} and L${i + 1}`, () => {
			const { text } = applyEdits(base, parsePatch(`INS.POST ${i}:\n+X`).edits);
			const out = text.split("\n");
			expect(out[i - 1]).toBe(`L${i}`);
			expect(out[i]).toBe("X");
			expect(out[i + 1]).toBe(`L${i + 1}`);
			expect(out).toHaveLength(n + 1);
		});
	}
});
