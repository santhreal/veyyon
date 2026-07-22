/**
 * DEL every contiguous window of size w on n=50 for w=1..6.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 DEL middle window n50", () => {
	const n = 50;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let w = 1; w <= 6; w++) {
		for (let s = 1; s + w - 1 <= n; s++) {
			const e = s + w - 1;
			it(`DEL ${s}.=${e}`, () => {
				const header = s === e ? `DEL ${s}` : `DEL ${s}.=${e}`;
				const { text, firstChangedLine } = applyEdits(base, parsePatch(header).edits);
				expect(text === "" ? [] : text.split("\n")).toEqual([
					...lines.slice(0, s - 1),
					...lines.slice(e),
				]);
				expect(firstChangedLine).toBe(s);
			});
		}
	}
});
