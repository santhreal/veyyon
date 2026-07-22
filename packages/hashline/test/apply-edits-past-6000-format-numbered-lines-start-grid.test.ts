/**
 * formatNumberedLines startLine grid: 1..100 start on 5-line file.
 */
import { describe, expect, it } from "bun:test";
import { formatNumberedLines } from "@veyyon/hashline";

describe("applyEdits past 6000 format numbered lines start grid", () => {
	const text = "a\nb\nc\nd\ne";
	for (let start = 1; start <= 100; start++) {
		it(`start=${start}`, () => {
			const out = formatNumberedLines(text, start).split("\n");
			expect(out).toHaveLength(5);
			for (let i = 0; i < 5; i++) {
				expect(out[i]).toBe(`${start + i}${"abcde"[i]}`.replace(/(\d+)(.)/, (_, n, c) => `${n}:${c}`));
			}
			// clearer:
			expect(out[0]).toBe(`${start}:a`);
			expect(out[4]).toBe(`${start + 4}:e`);
		});
	}
});
