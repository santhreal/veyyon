/**
 * DEL single line i for i=1..600 on n=600.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 DEL line 1 to 600", () => {
	const n = 600;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let i = 1; i <= n; i++) {
		it(`DEL ${i}`, () => {
			const { firstChangedLine } = applyEdits(base, parsePatch(`DEL ${i}`).edits);
			expect(firstChangedLine).toBe(i);
		});
	}
});
