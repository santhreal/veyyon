/**
 * truncateForPrompt: identity under max; over max keeps head and exact
 * omitted-char elision marker. Default max is 2000.
 */
import { describe, expect, it } from "bun:test";
import { truncateForPrompt } from "@veyyon/coding-agent/tools/approval";

describe("truncateForPrompt property", () => {
	it("identity when length <= max", () => {
		expect(truncateForPrompt("hello", 10)).toBe("hello");
		expect(truncateForPrompt("", 0)).toBe("");
		expect(truncateForPrompt("abc", 3)).toBe("abc");
	});

	for (const max of [1, 5, 10, 50, 100]) {
		it(`elides with exact omitted count at max=${max}`, () => {
			const value = "x".repeat(max + 17);
			const out = truncateForPrompt(value, max);
			expect(out).toBe(`${"x".repeat(max)}[…17ch elided…]`);
			expect(out.startsWith("x".repeat(max))).toBe(true);
			expect(out).toContain("[…17ch elided…]");
		});
	}

	it("default max is 2000", () => {
		const under = "a".repeat(2000);
		expect(truncateForPrompt(under)).toBe(under);
		const over = "a".repeat(2005);
		expect(truncateForPrompt(over)).toBe(`${"a".repeat(2000)}[…5ch elided…]`);
	});

	it("maxChars 0 elides entire string", () => {
		expect(truncateForPrompt("abc", 0)).toBe("[…3ch elided…]");
	});
});
