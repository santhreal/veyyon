/**
 * DEL middle half of n-line file: exact prefix+suffix remaining.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL middle half", () => {
	for (const n of [8, 12, 20]) {
		it(`n=${n}`, () => {
			const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
			const base = lines.join("\n");
			const start = Math.floor(n / 4) + 1;
			const end = start + Math.floor(n / 2) - 1;
			const { text } = applyEdits(base, parsePatch(`DEL ${start}.=${end}`).edits);
			const want = [...lines.slice(0, start - 1), ...lines.slice(end)];
			expect(text.split("\n")).toEqual(want);
		});
	}
});
