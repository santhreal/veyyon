/**
 * Contract tests for the small pure helpers in dialect/coercion.ts that the
 * in-band tool-call parser leans on: partial-suffix overlap (used to withhold a
 * stream tail that might be the start of a tool tag), Kimi function-name
 * normalization, and JSON type classification. Each is an off-by-one or
 * mis-mapping away from leaking tag bytes or misrouting a tool call, so pin them.
 */
import { describe, expect, it } from "bun:test";
import {
	jsonTypeOf,
	normalizeKimiFunctionName,
	partialSuffixOverlap,
	partialSuffixOverlapAny,
} from "@veyyon/ai/dialect/coercion";

describe("partialSuffixOverlap", () => {
	it("returns the length of the longest text suffix that is a prefix of the tag", () => {
		// "hello<tool" ends with "<tool", the first 5 chars of "<tool_call>".
		expect(partialSuffixOverlap("hello<tool", "<tool_call>")).toBe(5);
		expect(partialSuffixOverlap("a<", "<b>")).toBe(1);
	});

	it("returns 0 when no suffix of the text starts the tag", () => {
		expect(partialSuffixOverlap("hello", "<tool_call>")).toBe(0);
	});

	it("never reports a complete tag as a partial overlap (caps at tag.length-1)", () => {
		// A fully-present tag is handled by the complete-tag path, not this one, so
		// the overlap must stay strictly shorter than the whole tag.
		expect(partialSuffixOverlap("<tool_call>", "<tool_call>")).toBe(0);
		expect(partialSuffixOverlap("x<tool>", "<tool>")).toBe(0);
	});

	it("handles empty text and empty tag as no overlap", () => {
		expect(partialSuffixOverlap("", "<x>")).toBe(0);
		expect(partialSuffixOverlap("abc", "")).toBe(0);
	});
});

describe("partialSuffixOverlapAny", () => {
	it("returns the best overlap across all candidate tags", () => {
		// "</too" is a 5-char prefix of "</tool>" and no prefix of "<tool>".
		expect(partialSuffixOverlapAny("x</too", ["<tool>", "</tool>"])).toBe(5);
	});

	it("returns 0 for an empty tag list", () => {
		expect(partialSuffixOverlapAny("abc", [])).toBe(0);
	});
});

describe("normalizeKimiFunctionName", () => {
	it("drops an id suffix after the first colon and keeps the last dotted segment", () => {
		expect(normalizeKimiFunctionName("functions.get_weather:0")).toBe("get_weather");
		expect(normalizeKimiFunctionName("a.b.c")).toBe("c");
	});

	it("returns a bare name unchanged and trims surrounding whitespace", () => {
		expect(normalizeKimiFunctionName("foo:1")).toBe("foo");
		expect(normalizeKimiFunctionName(" a.b : 2")).toBe("b");
		expect(normalizeKimiFunctionName("")).toBe("");
	});
});

describe("jsonTypeOf", () => {
	it("classifies values by their JSON type", () => {
		expect(jsonTypeOf(null)).toBe("null");
		expect(jsonTypeOf(3)).toBe("number");
		expect(jsonTypeOf(3n)).toBe("number");
		expect(jsonTypeOf(true)).toBe("boolean");
		expect(jsonTypeOf("x")).toBe("string");
		expect(jsonTypeOf([1])).toBe("object");
		expect(jsonTypeOf({})).toBe("object");
	});

	it("maps undefined (not a JSON value) to object, the catch-all branch", () => {
		expect(jsonTypeOf(undefined)).toBe("object");
	});
});
