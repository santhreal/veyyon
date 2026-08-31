/**
 * DEL single line i for i=1..120 on n=120.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 DEL line 1 to 120", () => {
	const n = 120;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let i = 1; i <= n; i++) {
		it(`DEL ${i}`, () => {
			const { text, firstChangedLine } = applyEdits(base, parsePatch(`DEL ${i}`).edits);
			expect(text === "" ? [] : text.split("\n")).toEqual(lines.filter((_, idx) => idx + 1 !== i));
			expect(firstChangedLine).toBe(i);
		});
	}
});
