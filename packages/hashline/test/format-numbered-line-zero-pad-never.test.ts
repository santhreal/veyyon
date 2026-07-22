/**
 * formatNumberedLine never left-pads line numbers.
 */
import { describe, expect, it } from "bun:test";
import { formatNumberedLine } from "@veyyon/hashline";

describe("formatNumberedLine no left pad", () => {
	const nums = [1, 9, 10, 99, 100, 999, 1000, 9999, 10000];
	for (const n of nums) {
		it(`N=${n}`, () => {
			const s = formatNumberedLine(n, "x");
			expect(s.startsWith(`${n}:`)).toBe(true);
			expect(s).toBe(`${n}:x`);
			expect(s).not.toMatch(/^0/);
		});
	}
});
