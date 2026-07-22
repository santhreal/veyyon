/**
 * truncateForPrompt exact elision contract: under max untouched; over max suffix form.
 * Why: prompt truncation must preserve prefix and report exact omitted char count.
 */
import { describe, expect, it } from "bun:test";
import { truncateForPrompt } from "../src/tools/approval";

describe("truncateForPrompt pure matrix", () => {
	it("under max returns identity", () => {
		expect(truncateForPrompt("hello", 10)).toBe("hello");
		expect(truncateForPrompt("", 5)).toBe("");
		expect(truncateForPrompt("abcd", 4)).toBe("abcd");
	});

	it("exact default path for short strings", () => {
		const s = "x".repeat(100);
		expect(truncateForPrompt(s)).toBe(s);
	});

	for (const max of [1, 5, 10, 50, 100]) {
		it(`max=${max} over by 7 elides exact`, () => {
			const s = "a".repeat(max + 7);
			const out = truncateForPrompt(s, max);
			expect(out).toBe(`${"a".repeat(max)}[…7ch elided…]`);
			expect(out.startsWith("a".repeat(max))).toBe(true);
			expect(out).toContain("7ch elided");
		});
	}

	it("over by 1 uses 1ch elided", () => {
		expect(truncateForPrompt("abcdef", 5)).toBe("abcde[…1ch elided…]");
	});

	it("unicode counted by JS string length", () => {
		const s = "🚀".repeat(10);
		const out = truncateForPrompt(s, 4);
		// each emoji is length 2 in JS
		expect(out.startsWith(s.slice(0, 4))).toBe(true);
		expect(out).toContain("ch elided");
	});
});
