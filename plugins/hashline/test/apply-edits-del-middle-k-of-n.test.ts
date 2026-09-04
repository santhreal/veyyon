/**
 * DEL middle k lines of n-line file for several n,k.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL middle k of n", () => {
	const cases: Array<{ n: number; start: number; end: number }> = [
		{ n: 5, start: 2, end: 2 },
		{ n: 5, start: 2, end: 4 },
		{ n: 7, start: 3, end: 5 },
		{ n: 8, start: 4, end: 5 },
		{ n: 10, start: 4, end: 7 },
	];
	for (const { n, start, end } of cases) {
		it(`n=${n} DEL ${start}.=${end}`, () => {
			const base = Array.from({ length: n }, (_, i) => `L${i + 1}`);
			const header = start === end ? `DEL ${start}` : `DEL ${start}.=${end}`;
			const { text: out } = applyEdits(base.join("\n"), parsePatch(header).edits);
			const want = base.filter((_, i) => i + 1 < start || i + 1 > end).join("\n");
			expect(out).toBe(want);
		});
	}
});
