import { describe, expect, it } from "bun:test";
import { clamp, clamp01, clampLow } from "../src/math";
import {
	ALNUM_RE,
	ALNUM_WORD_RE,
	DATE_ONLY_RE,
	escapeRegExp,
	hasAlphanumeric,
	isDateOnly,
	isUuid,
	NON_ALNUM_RUN_RE,
	UUID_RE,
} from "../src/regex";

describe("clamp", () => {
	it("returns value when in range", () => {
		expect(clamp(5, 0, 10)).toBe(5);
	});
	it("returns min when below range", () => {
		expect(clamp(-5, 0, 10)).toBe(0);
	});
	it("returns max when above range", () => {
		expect(clamp(15, 0, 10)).toBe(10);
	});
	it("returns min for NaN", () => {
		expect(clamp(Number.NaN, 0, 10)).toBe(0);
	});
	it("returns min for Infinity", () => {
		expect(clamp(Number.POSITIVE_INFINITY, 0, 10)).toBe(0);
	});
	it("returns min for -Infinity", () => {
		expect(clamp(Number.NEGATIVE_INFINITY, 0, 10)).toBe(0);
	});
	it("handles negative ranges", () => {
		expect(clamp(-15, -10, -5)).toBe(-10);
		expect(clamp(-7, -10, -5)).toBe(-7);
		expect(clamp(0, -10, -5)).toBe(-5);
	});
	it("handles value equal to min", () => {
		expect(clamp(0, 0, 10)).toBe(0);
	});
	it("handles value equal to max", () => {
		expect(clamp(10, 0, 10)).toBe(10);
	});
});

describe("clamp01", () => {
	it("returns value when in [0,1]", () => {
		expect(clamp01(0.5)).toBe(0.5);
	});
	it("returns 0 when below 0", () => {
		expect(clamp01(-0.5)).toBe(0);
	});
	it("returns 1 when above 1", () => {
		expect(clamp01(1.5)).toBe(1);
	});
	it("returns 0 for NaN", () => {
		expect(clamp01(Number.NaN)).toBe(0);
	});
	it("returns 0 for Infinity", () => {
		expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0);
	});
	it("handles 0", () => {
		expect(clamp01(0)).toBe(0);
	});
	it("handles 1", () => {
		expect(clamp01(1)).toBe(1);
	});
});

describe("clampLow", () => {
	it("returns value when in range", () => {
		expect(clampLow(5, 0, 10)).toBe(5);
	});
	it("returns low when below range", () => {
		expect(clampLow(-5, 0, 10)).toBe(0);
	});
	it("returns high when above range", () => {
		expect(clampLow(15, 0, 10)).toBe(10);
	});
	it("returns low for NaN", () => {
		expect(clampLow(Number.NaN, 0, 10)).toBe(0);
	});
	it("returns low when range is empty (high < low)", () => {
		expect(clampLow(5, 0, -1)).toBe(0);
	});
	it("returns low for empty range with value below", () => {
		expect(clampLow(-5, 0, -1)).toBe(0);
	});
	it("handles negative ranges", () => {
		expect(clampLow(-7, -10, -5)).toBe(-7);
	});
});

describe("escapeRegExp", () => {
	it("escapes special regex chars", () => {
		expect(escapeRegExp("a.b*c")).toBe("a\\.b\\*c");
	});
	it("escapes all special chars", () => {
		expect(escapeRegExp(".*+?^${}()|[]\\")).toBe("\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\");
	});
	it("does not escape normal chars", () => {
		expect(escapeRegExp("hello")).toBe("hello");
	});
	it("handles empty string", () => {
		expect(escapeRegExp("")).toBe("");
	});
	it("does not escape dash (not in special chars set)", () => {
		expect(escapeRegExp("a-b")).toBe("a-b");
	});
});

describe("hasAlphanumeric", () => {
	it("returns true for alphanumeric text", () => {
		expect(hasAlphanumeric("hello")).toBe(true);
		expect(hasAlphanumeric("123")).toBe(true);
	});
	it("returns true for unicode letters", () => {
		expect(hasAlphanumeric("héllo")).toBe(true);
		expect(hasAlphanumeric("日本語")).toBe(true);
	});
	it("returns false for punctuation only", () => {
		expect(hasAlphanumeric("!!!")).toBe(false);
		expect(hasAlphanumeric("...")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(hasAlphanumeric("")).toBe(false);
	});
	it("returns false for whitespace", () => {
		expect(hasAlphanumeric("   ")).toBe(false);
	});
	it("returns true for mixed content", () => {
		expect(hasAlphanumeric("hello world")).toBe(true);
	});
});

describe("ALNUM_RE", () => {
	it("matches a single letter", () => {
		expect(ALNUM_RE.test("a")).toBe(true);
	});
	it("matches a single digit", () => {
		expect(ALNUM_RE.test("5")).toBe(true);
	});
	it("does not match punctuation", () => {
		expect(ALNUM_RE.test("!")).toBe(false);
	});
});

describe("NON_ALNUM_RUN_RE", () => {
	it("splits on non-alphanumeric runs", () => {
		expect("hello world".split(NON_ALNUM_RUN_RE)).toEqual(["hello", "world"]);
	});
	it("collapses multiple separators", () => {
		expect("a...b".split(NON_ALNUM_RUN_RE)).toEqual(["a", "b"]);
	});
	it("replaces runs with single space", () => {
		expect("hello   world".replace(NON_ALNUM_RUN_RE, " ")).toBe("hello world");
	});
});

describe("ALNUM_WORD_RE", () => {
	it("matches words in string", () => {
		const matches = "hello world 123".match(ALNUM_WORD_RE);
		expect(matches).toEqual(["hello", "world", "123"]);
	});
	it("matches unicode words", () => {
		const matches = "héllo wörld".match(ALNUM_WORD_RE);
		expect(matches).toEqual(["héllo", "wörld"]);
	});
});

describe("isUuid", () => {
	it("returns true for valid UUID", () => {
		expect(isUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
	});
	it("returns true for lowercase UUID", () => {
		expect(isUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
	});
	it("returns true for uppercase UUID", () => {
		expect(isUuid("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
	});
	it("returns false for invalid UUID", () => {
		expect(isUuid("not-a-uuid")).toBe(false);
	});
	it("returns false for partial UUID", () => {
		expect(isUuid("550e8400-e29b-41d4")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(isUuid("")).toBe(false);
	});
	it("returns false for UUID without dashes", () => {
		expect(isUuid("550e8400e29b41d4a716446655440000")).toBe(false);
	});
});

describe("isDateOnly", () => {
	it("returns true for valid date shape", () => {
		expect(isDateOnly("2024-03-15")).toBe(true);
	});
	it("returns true for date with invalid month/day (shape only)", () => {
		expect(isDateOnly("2024-99-99")).toBe(true);
	});
	it("returns false for date with time", () => {
		expect(isDateOnly("2024-03-15T10:00:00")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(isDateOnly("")).toBe(false);
	});
	it("returns false for non-date string", () => {
		expect(isDateOnly("hello")).toBe(false);
	});
	it("returns false for date without dashes", () => {
		expect(isDateOnly("20240315")).toBe(false);
	});
	it("returns false for date with single-digit month/day", () => {
		expect(isDateOnly("2024-3-5")).toBe(false);
	});
});

describe("UUID_RE", () => {
	it("is anchored (matches whole string only)", () => {
		expect(UUID_RE.test("prefix-550e8400-e29b-41d4-a716-446655440000-suffix")).toBe(false);
	});
});

describe("DATE_ONLY_RE", () => {
	it("is anchored", () => {
		expect(DATE_ONLY_RE.test("prefix 2024-03-15 suffix")).toBe(false);
	});
});
