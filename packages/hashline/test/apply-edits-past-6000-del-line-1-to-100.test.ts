/**
 * DEL single line i for i=1..100 on n=100: exact remaining multiset + firstChangedLine.
 * Why: single-line delete identity past the 80-line band.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 DEL line 1 to 100", () => {
	const n = 100;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let i = 1; i <= n; i++) {
		it(`DEL ${i}`, () => {
			const { text, firstChangedLine } = applyEdits(base, parsePatch(`DEL ${i}`).edits);
			const out = text === "" ? [] : text.split("\n");
			expect(out).toHaveLength(n - 1);
			expect(out).toEqual(lines.filter((_, idx) => idx + 1 !== i));
			expect(firstChangedLine).toBe(i);
		});
	}
});
