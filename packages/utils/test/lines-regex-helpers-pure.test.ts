import { describe, expect, it } from "bun:test";
import { splitTextLines } from "../src/lines";
import { ALNUM_RE, DATE_ONLY_RE, escapeRegExp, hasAlphanumeric, isDateOnly, isUuid, UUID_RE } from "../src/regex";

describe("splitTextLines", () => {
	it("splits two lines", () => {
		expect(splitTextLines("a\nb")).toEqual(["a", "b"]);
	});
	it("drops trailing newline's empty line", () => {
		expect(splitTextLines("a\nb\n")).toEqual(["a", "b"]);
	});
	it("preserves interior blank lines", () => {
		expect(splitTextLines("a\n\nb")).toEqual(["a", "", "b"]);
	});
	it("returns empty array for empty string", () => {
		expect(splitTextLines("")).toEqual([]);
	});
	it("returns single empty string for single newline", () => {
		expect(splitTextLines("\n")).toEqual([""]);
	});
	it("handles single line without newline", () => {
		expect(splitTextLines("hello")).toEqual(["hello"]);
	});
	it("handles multiple trailing newlines", () => {
		expect(splitTextLines("a\n\n")).toEqual(["a", ""]);
	});
	it("handles only blank lines", () => {
		expect(splitTextLines("\n\n\n")).toEqual(["", "", ""]);
	});
});

describe("escapeRegExp", () => {
	it("escapes dot", () => {
		expect(escapeRegExp("a.b")).toBe("a\\.b");
	});
	it("escapes all special chars", () => {
		expect(escapeRegExp(".*+?^${}()|[]\\")).toBe("\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\");
	});
	it("returns plain text unchanged", () => {
		expect(escapeRegExp("hello")).toBe("hello");
	});
	it("handles empty string", () => {
		expect(escapeRegExp("")).toBe("");
	});
	it("does not escape hyphen (not a regex special char outside class)", () => {
		expect(escapeRegExp("a-b")).toBe("a-b");
	});
});

describe("hasAlphanumeric", () => {
	it("returns true for letters", () => {
		expect(hasAlphanumeric("hello")).toBe(true);
	});
	it("returns true for numbers", () => {
		expect(hasAlphanumeric("123")).toBe(true);
	});
	it("returns true for mixed", () => {
		expect(hasAlphanumeric("hello123")).toBe(true);
	});
	it("returns false for punctuation only", () => {
		expect(hasAlphanumeric("!@#$%")).toBe(false);
	});
	it("returns false for whitespace only", () => {
		expect(hasAlphanumeric("   ")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(hasAlphanumeric("")).toBe(false);
	});
	it("returns true for unicode letters", () => {
		expect(hasAlphanumeric("héllo")).toBe(true);
	});
	it("returns true with embedded number", () => {
		expect(hasAlphanumeric("!a!")).toBe(true);
	});
});

describe("isUuid", () => {
	it("validates canonical UUID", () => {
		expect(isUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
	});
	it("is case-insensitive", () => {
		expect(isUuid("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
	});
	it("rejects uppercase-only check passes", () => {
		expect(isUuid("ABCDEF12-1234-1234-1234-ABCDEF123456")).toBe(true);
	});
	it("rejects missing hyphens", () => {
		expect(isUuid("550e8400e29b41d4a716446655440000")).toBe(false);
	});
	it("rejects wrong length", () => {
		expect(isUuid("550e8400-e29b-41d4-a716-44665544000")).toBe(false);
	});
	it("rejects non-hex chars", () => {
		expect(isUuid("550e8400-e29b-41d4-a716-44665544000g")).toBe(false);
	});
	it("rejects empty string", () => {
		expect(isUuid("")).toBe(false);
	});
	it("rejects partial UUID", () => {
		expect(isUuid("550e8400-e29b")).toBe(false);
	});
});

describe("isDateOnly", () => {
	it("validates standard date", () => {
		expect(isDateOnly("2024-01-15")).toBe(true);
	});
	it("validates date with zeros", () => {
		expect(isDateOnly("2024-00-00")).toBe(true);
	});
	it("does not range-check month/day", () => {
		expect(isDateOnly("2024-99-99")).toBe(true);
	});
	it("rejects missing leading zero on day", () => {
		expect(isDateOnly("2024-1-5")).toBe(false);
	});
	it("rejects time component", () => {
		expect(isDateOnly("2024-01-15T10:30:00")).toBe(false);
	});
	it("rejects empty string", () => {
		expect(isDateOnly("")).toBe(false);
	});
	it("rejects wrong separator", () => {
		expect(isDateOnly("2024/01/15")).toBe(false);
	});
	it("rejects short year", () => {
		expect(isDateOnly("24-01-15")).toBe(false);
	});
});

describe("ALNUM_RE", () => {
	it("is non-global", () => {
		expect(ALNUM_RE.global).toBe(false);
	});
});

describe("UUID_RE", () => {
	it("is non-global", () => {
		expect(UUID_RE.global).toBe(false);
	});
	it("is case-insensitive", () => {
		expect(UUID_RE.ignoreCase).toBe(true);
	});
});

describe("DATE_ONLY_RE", () => {
	it("is non-global", () => {
		expect(DATE_ONLY_RE.global).toBe(false);
	});
});
