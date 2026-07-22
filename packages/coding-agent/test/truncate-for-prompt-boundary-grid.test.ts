/**
 * truncateForPrompt boundary: max-1, max, max+1 for several max values.
 */
import { describe, expect, it } from "bun:test";
import { truncateForPrompt } from "../src/tools/approval";

describe("truncateForPrompt boundary grid", () => {
	for (const max of [1, 2, 5, 10, 20, 50, 100, 200]) {
		it(`max=${max} under`, () => {
			const s = "a".repeat(Math.max(0, max - 1));
			expect(truncateForPrompt(s, max)).toBe(s);
		});

		it(`max=${max} exact`, () => {
			const s = "a".repeat(max);
			expect(truncateForPrompt(s, max)).toBe(s);
		});

		it(`max=${max} over by 1`, () => {
			const s = "a".repeat(max + 1);
			expect(truncateForPrompt(s, max)).toBe(`${"a".repeat(max)}[…1ch elided…]`);
		});

		it(`max=${max} over by 10`, () => {
			const s = "a".repeat(max + 10);
			expect(truncateForPrompt(s, max)).toBe(`${"a".repeat(max)}[…10ch elided…]`);
		});
	}
});
