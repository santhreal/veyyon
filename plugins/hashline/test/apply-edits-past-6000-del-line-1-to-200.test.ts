/**
 * DEL single line i for i=1..200 on n=200.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 DEL line 1 to 200", () => {
	const n = 200;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let i = 1; i <= n; i++) {
		it(`DEL ${i}`, () => {
			const { text, firstChangedLine } = applyEdits(base, parsePatch(`DEL ${i}`).edits);
			expect(text === "" ? [] : text.split("\n")).toHaveLength(n - 1);
			expect(firstChangedLine).toBe(i);
		});
	}
});
