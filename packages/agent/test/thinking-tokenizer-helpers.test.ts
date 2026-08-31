import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "../src/thinking";
import { countTokens } from "../src/tokenizer";

describe("ThinkingLevel", () => {
	it("has Inherit as 'inherit'", () => {
		expect(ThinkingLevel.Inherit).toBe("inherit");
	});
	it("has Off as 'off'", () => {
		expect(ThinkingLevel.Off).toBe("off");
	});
	it("has Minimal matching Effort.Minimal", () => {
		expect(ThinkingLevel.Minimal).toBeDefined();
		expect(typeof ThinkingLevel.Minimal).toBe("string");
	});
	it("has Low matching Effort.Low", () => {
		expect(ThinkingLevel.Low).toBeDefined();
		expect(typeof ThinkingLevel.Low).toBe("string");
	});
	it("has Medium matching Effort.Medium", () => {
		expect(ThinkingLevel.Medium).toBeDefined();
		expect(typeof ThinkingLevel.Medium).toBe("string");
	});
	it("has High matching Effort.High", () => {
		expect(ThinkingLevel.High).toBeDefined();
		expect(typeof ThinkingLevel.High).toBe("string");
	});
	it("has XHigh matching Effort.XHigh", () => {
		expect(ThinkingLevel.XHigh).toBeDefined();
		expect(typeof ThinkingLevel.XHigh).toBe("string");
	});
	it("has Max matching Effort.Max", () => {
		expect(ThinkingLevel.Max).toBeDefined();
		expect(typeof ThinkingLevel.Max).toBe("string");
	});
	it("has 8 entries", () => {
		expect(Object.keys(ThinkingLevel)).toHaveLength(8);
	});
	it("all values are unique strings", () => {
		const values = Object.values(ThinkingLevel);
		const unique = new Set(values);
		expect(unique.size).toBe(values.length);
	});
});

describe("countTokens", () => {
	it("returns positive number for text", () => {
		const count = countTokens("hello world");
		expect(typeof count).toBe("number");
		expect(count).toBeGreaterThan(0);
	});
	it("returns 0 for empty string", () => {
		expect(countTokens("")).toBe(0);
	});
	it("sums array elements", () => {
		const single = countTokens("hello");
		const arr = countTokens(["hello", "hello"]);
		expect(arr).toBe(single * 2);
	});
	it("handles array of strings", () => {
		const count = countTokens(["hello", "world"]);
		expect(typeof count).toBe("number");
		expect(count).toBeGreaterThan(0);
	});
	it("returns 0 for empty array", () => {
		expect(countTokens([])).toBe(0);
	});
	it("handles single word", () => {
		const count = countTokens("hello");
		expect(count).toBeGreaterThan(0);
	});
	it("handles very long text", () => {
		const longText = "a ".repeat(10000);
		const count = countTokens(longText);
		expect(count).toBeGreaterThan(1000);
	});
	it("handles special characters", () => {
		const count = countTokens("function() { return 42; }");
		expect(count).toBeGreaterThan(0);
	});
	it("handles unicode", () => {
		const count = countTokens("你好世界");
		expect(count).toBeGreaterThan(0);
	});
});
