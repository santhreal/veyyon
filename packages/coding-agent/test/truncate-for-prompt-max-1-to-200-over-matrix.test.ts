/**
 * truncateForPrompt maxChars 1..200, over by k=1..10: exact elision form.
 * Why: every boundary max must preserve prefix and report exact omitted count.
 */
import { describe, expect, it } from "bun:test";
import { truncateForPrompt } from "../src/tools/approval";

describe("truncateForPrompt max 1 to 200 over matrix", () => {
	for (let max = 1; max <= 200; max++) {
		for (const over of [1, 2, 5, 10]) {
			it(`max=${max} over=${over}`, () => {
				const s = "z".repeat(max + over);
				const out = truncateForPrompt(s, max);
				expect(out).toBe(`${"z".repeat(max)}[…${over}ch elided…]`);
			});
		}
	}

	it("identity for length exactly max", () => {
		for (const max of [1, 7, 50, 200]) {
			const s = "q".repeat(max);
			expect(truncateForPrompt(s, max)).toBe(s);
		}
	});
});
