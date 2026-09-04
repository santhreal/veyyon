/**
 * formatNumberedLines startLine offset grid: first number is startLine.
 */
import { describe, expect, it } from "bun:test";
import { formatNumberedLines } from "@veyyon/hashline";

describe("formatNumberedLines startLine grid", () => {
	for (const start of [1, 2, 10, 100, 1000]) {
		it(`startLine=${start}`, () => {
			const out = formatNumberedLines("a\nb\nc", start);
			const lines = out.split("\n");
			expect(lines[0]).toBe(`${start}:a`);
			expect(lines[1]).toBe(`${start + 1}:b`);
			expect(lines[2]).toBe(`${start + 2}:c`);
		});
	}
});
