import { describe, expect, it } from "bun:test";
import { DEFAULT_TOOL_CALL_STRUCTURE_SHARE } from "../src/constants";
import { emittedTokenCost, estimateTokens, scoringFrequency } from "../src/generate";

describe("estimateTokens", () => {
	it("returns 0 for empty string", () => {
		expect(estimateTokens("")).toBe(0);
	});
	it("returns at least 1 for non-empty string", () => {
		expect(estimateTokens("hello")).toBeGreaterThanOrEqual(1);
	});
	it("estimates word tokens as ceil(len/4)", () => {
		expect(estimateTokens("hello")).toBe(2);
	});
	it("estimates single char word as 1 token", () => {
		expect(estimateTokens("a")).toBe(1);
	});
	it("counts symbols", () => {
		const result = estimateTokens("///");
		expect(result).toBeGreaterThanOrEqual(3);
	});
	it("handles mixed words and symbols", () => {
		const result = estimateTokens("foo/bar");
		expect(result).toBeGreaterThanOrEqual(2);
	});
	it("handles long word", () => {
		expect(estimateTokens("abcdefghij")).toBe(3);
	});
	it("handles whitespace-only string", () => {
		expect(estimateTokens("   ")).toBeGreaterThanOrEqual(1);
	});
	it("handles whitespace-only string as 1", () => {
		expect(estimateTokens("\n\n")).toBe(1);
	});
});

describe("scoringFrequency", () => {
	it("returns documentFrequency when rawFrequency equals documentFrequency", () => {
		expect(scoringFrequency(10, 10)).toBe(10);
	});
	it("returns documentFrequency when rawFrequency is less", () => {
		expect(scoringFrequency(5, 10)).toBe(10);
	});
	it("applies log2 scaling for excess frequency", () => {
		const result = scoringFrequency(20, 10);
		// within = 10, log2(11) ≈ 3.46, floor = 3, so 10 + 3 = 13
		expect(result).toBe(13);
	});
	it("handles zero raw and document frequency", () => {
		expect(scoringFrequency(0, 0)).toBe(0);
	});
	it("handles large excess", () => {
		const result = scoringFrequency(100, 1);
		// within = 99, log2(100) ≈ 6.64, floor = 6, so 1 + 6 = 7
		expect(result).toBe(7);
	});
	it("handles rawFrequency of 1 and documentFrequency of 1", () => {
		expect(scoringFrequency(1, 1)).toBe(1);
	});
	it("handles rawFrequency of 2 and documentFrequency of 1", () => {
		// within = 1, log2(2) = 1, floor = 1, so 1 + 1 = 2
		expect(scoringFrequency(2, 1)).toBe(2);
	});
});

describe("emittedTokenCost", () => {
	const countTokens = (text: string): number => estimateTokens(text);

	it("returns countTokens for non-line-structure expansion", () => {
		const expansion = "hello world";
		expect(emittedTokenCost(expansion, countTokens)).toBe(countTokens(expansion));
	});
	it("returns weighted cost for line-structure expansion", () => {
		const expansion = "\n  function";
		const escaped = countTokens(JSON.stringify(expansion).slice(1, -1));
		const raw = countTokens(expansion);
		const expected = DEFAULT_TOOL_CALL_STRUCTURE_SHARE * escaped + (1 - DEFAULT_TOOL_CALL_STRUCTURE_SHARE) * raw;
		expect(emittedTokenCost(expansion, countTokens)).toBe(expected);
	});
	it("throws on toolCallStructureShare < 0", () => {
		expect(() => emittedTokenCost("hello", countTokens, -0.1)).toThrow(RangeError);
	});
	it("throws on toolCallStructureShare > 1", () => {
		expect(() => emittedTokenCost("hello", countTokens, 1.1)).toThrow(RangeError);
	});
	it("throws on NaN toolCallStructureShare", () => {
		expect(() => emittedTokenCost("hello", countTokens, Number.NaN)).toThrow(RangeError);
	});
	it("throws on Infinity toolCallStructureShare", () => {
		expect(() => emittedTokenCost("hello", countTokens, Number.POSITIVE_INFINITY)).toThrow(RangeError);
	});
	it("accepts toolCallStructureShare of 0", () => {
		const expansion = "\n  function";
		const raw = countTokens(expansion);
		expect(emittedTokenCost(expansion, countTokens, 0)).toBe(raw);
	});
	it("accepts toolCallStructureShare of 1", () => {
		const expansion = "\n  function";
		const escaped = countTokens(JSON.stringify(expansion).slice(1, -1));
		expect(emittedTokenCost(expansion, countTokens, 1)).toBe(escaped);
	});
	it("handles empty expansion", () => {
		expect(emittedTokenCost("", countTokens)).toBe(countTokens(""));
	});
	it("handles expansion starting with newline only", () => {
		const expansion = "\n";
		const escaped = countTokens(JSON.stringify(expansion).slice(1, -1));
		const raw = countTokens(expansion);
		const expected = DEFAULT_TOOL_CALL_STRUCTURE_SHARE * escaped + (1 - DEFAULT_TOOL_CALL_STRUCTURE_SHARE) * raw;
		expect(emittedTokenCost(expansion, countTokens)).toBe(expected);
	});
});
