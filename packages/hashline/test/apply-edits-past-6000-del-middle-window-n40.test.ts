/**
 * DEL every contiguous window of size w starting at s on n=40 for w=1..8.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 DEL middle window n40", () => {
	const n = 40;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let w = 1; w <= 8; w++) {
		for (let s = 1; s + w - 1 <= n; s++) {
			const e = s + w - 1;
			it(`DEL ${s}.=${e}`, () => {
				const header = s === e ? `DEL ${s}` : `DEL ${s}.=${e}`;
				const { text, firstChangedLine } = applyEdits(base, parsePatch(header).edits);
				const expected = [...lines.slice(0, s - 1), ...lines.slice(e)];
				expect(text === "" ? [] : text.split("\n")).toEqual(expected);
				expect(firstChangedLine).toBe(s);
			});
		}
	}
});
