import { describe, expect, it } from "bun:test";
import { splitTextLines } from "../src/lines";
import { clamp, clamp01, clampLow } from "../src/math";
import { DATE_ONLY_RE, escapeRegExp, hasAlphanumeric, isDateOnly, isUuid, UUID_RE } from "../src/regex";
import { escapeXmlAttribute, escapeXmlText, sanitizeText, splitTrailingPartialEscape } from "../src/sanitize-text";

describe("splitTextLines", () => {
	it("splits text by newlines", () => {
		expect(splitTextLines("a\nb\nc")).toEqual(["a", "b", "c"]);
	});

	it("filters trailing empty line from final newline", () => {
		expect(splitTextLines("a\nb\n")).toEqual(["a", "b"]);
	});

	it("preserves empty lines in the middle", () => {
		expect(splitTextLines("a\n\nb")).toEqual(["a", "", "b"]);
	});

	it("handles single line without newline", () => {
		expect(splitTextLines("hello")).toEqual(["hello"]);
	});

	it("handles empty string", () => {
		expect(splitTextLines("")).toEqual([]);
	});

	it("handles only newlines", () => {
		expect(splitTextLines("\n\n\n")).toEqual(["", "", ""]);
	});

	it("handles trailing newline on single line", () => {
		expect(splitTextLines("hello\n")).toEqual(["hello"]);
	});

	it("preserves whitespace lines", () => {
		expect(splitTextLines("a\n  \nb")).toEqual(["a", "  ", "b"]);
	});
});

describe("clamp", () => {
	it("returns value when in range", () => {
		expect(clamp(5, 0, 10)).toBe(5);
	});

	it("returns min when below range", () => {
		expect(clamp(-1, 0, 10)).toBe(0);
	});

	it("returns max when above range", () => {
		expect(clamp(11, 0, 10)).toBe(10);
	});

	it("returns min for NaN", () => {
		expect(clamp(NaN, 0, 10)).toBe(0);
	});

	it("returns min for Infinity", () => {
		expect(clamp(Infinity, 0, 10)).toBe(0);
	});

	it("returns min for -Infinity", () => {
		expect(clamp(-Infinity, 0, 10)).toBe(0);
	});

	it("handles value equal to min", () => {
		expect(clamp(0, 0, 10)).toBe(0);
	});

	it("handles value equal to max", () => {
		expect(clamp(10, 0, 10)).toBe(10);
	});

	it("handles negative range", () => {
		expect(clamp(-5, -10, -1)).toBe(-5);
	});
});

describe("clamp01", () => {
	it("returns value when in [0, 1]", () => {
		expect(clamp01(0.5)).toBe(0.5);
	});

	it("returns 0 for negative", () => {
		expect(clamp01(-0.1)).toBe(0);
	});

	it("returns 1 for > 1", () => {
		expect(clamp01(1.5)).toBe(1);
	});

	it("returns 0 for NaN", () => {
		expect(clamp01(NaN)).toBe(0);
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
		expect(clampLow(-1, 0, 10)).toBe(0);
	});

	it("returns high when above range", () => {
		expect(clampLow(11, 0, 10)).toBe(10);
	});

	it("returns low for NaN", () => {
		expect(clampLow(NaN, 0, 10)).toBe(0);
	});

	it("returns low for Infinity", () => {
		expect(clampLow(Infinity, 0, 10)).toBe(0);
	});
});

describe("escapeRegExp", () => {
	it("escapes dot", () => {
		expect(escapeRegExp("a.b")).toBe("a\\.b");
	});

	it("escapes all special chars", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: regex special chars fixture contains literal ${} syntax
		expect(escapeRegExp(".*+?^${}()|[]\\")).toBe("\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\");
	});

	it("does not escape normal chars", () => {
		expect(escapeRegExp("hello")).toBe("hello");
	});

	it("handles empty string", () => {
		expect(escapeRegExp("")).toBe("");
	});

	it("produces a valid regex that matches literally", () => {
		const special = "a.b*c";
		const pattern = new RegExp(escapeRegExp(special));
		expect(pattern.test(special)).toBe(true);
		expect(pattern.test("axbxc")).toBe(false);
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
		expect(hasAlphanumeric("abc123")).toBe(true);
	});

	it("returns false for punctuation only", () => {
		expect(hasAlphanumeric("!!!")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(hasAlphanumeric("")).toBe(false);
	});

	it("returns true for unicode letters", () => {
		expect(hasAlphanumeric("你好")).toBe(true);
	});

	it("returns false for whitespace", () => {
		expect(hasAlphanumeric("   ")).toBe(false);
	});

	it("returns true when alphanumeric is embedded", () => {
		expect(hasAlphanumeric("!a!")).toBe(true);
	});
});

describe("isUuid", () => {
	it("returns true for valid UUID", () => {
		expect(isUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
	});

	it("returns true for lowercase uuid", () => {
		expect(isUuid("12345678-1234-1234-1234-123456789012")).toBe(true);
	});

	it("returns true for uppercase UUID", () => {
		expect(isUuid("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
	});

	it("returns false for non-UUID string", () => {
		expect(isUuid("not-a-uuid")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isUuid("")).toBe(false);
	});

	it("returns false for partial UUID", () => {
		expect(isUuid("550e8400-e29b-41d4-a716")).toBe(false);
	});

	it("returns false for UUID without hyphens", () => {
		expect(isUuid("550e8400e29b41d4a716446655440000")).toBe(false);
	});

	it("UUID_RE is case-insensitive", () => {
		expect(UUID_RE.test("ABCDEF12-3456-7890-ABCD-EF1234567890")).toBe(true);
	});
});

describe("isDateOnly", () => {
	it("returns true for valid date", () => {
		expect(isDateOnly("2024-01-15")).toBe(true);
	});

	it("returns true for another valid date", () => {
		expect(isDateOnly("1999-12-31")).toBe(true);
	});

	it("returns false for datetime", () => {
		expect(isDateOnly("2024-01-15T10:30:00")).toBe(false);
	});

	it("returns false for non-date string", () => {
		expect(isDateOnly("not-a-date")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isDateOnly("")).toBe(false);
	});

	it("returns false for date without leading zeros", () => {
		expect(isDateOnly("2024-1-5")).toBe(false);
	});

	it("returns false for date with time", () => {
		expect(isDateOnly("2024-01-15 10:30")).toBe(false);
	});

	it("DATE_ONLY_RE matches valid date", () => {
		expect(DATE_ONLY_RE.test("2024-01-15")).toBe(true);
	});
});

describe("sanitizeText", () => {
	it("returns plain text unchanged", () => {
		expect(sanitizeText("hello world")).toBe("hello world");
	});

	it("returns empty string unchanged", () => {
		expect(sanitizeText("")).toBe("");
	});

	it("strips control characters", () => {
		expect(sanitizeText("hello\x00world")).toBe("helloworld");
	});

	it("strips BEL character", () => {
		expect(sanitizeText("hello\x07world")).toBe("helloworld");
	});

	it("preserves newlines and tabs", () => {
		expect(sanitizeText("hello\n\tworld")).toBe("hello\n\tworld");
	});

	it("strips ANSI escape sequences", () => {
		expect(sanitizeText("hello\x1b[31mworld\x1b[0m")).toBe("helloworld");
	});

	it("strips DEL character", () => {
		expect(sanitizeText("hello\x7Fworld")).toBe("helloworld");
	});
});

describe("splitTrailingPartialEscape", () => {
	it("returns whole text as head when no escape char", () => {
		expect(splitTrailingPartialEscape("hello")).toEqual({ head: "hello", partial: "" });
	});

	it("returns whole text as head when no partial escape", () => {
		// Complete escape sequence: ESC[31m
		expect(splitTrailingPartialEscape("hello\x1b[31m")).toEqual({ head: "hello\x1b[31m", partial: "" });
	});

	it("splits trailing partial CSI sequence", () => {
		// ESC[ without final byte is a partial escape
		const result = splitTrailingPartialEscape("hello\x1b[3");
		expect(result.head).toBe("hello");
		expect(result.partial).toBe("\x1b[3");
	});

	it("handles text with no trailing partial", () => {
		const result = splitTrailingPartialEscape("hello\x1b[0m world");
		expect(result.head).toBe("hello\x1b[0m world");
		expect(result.partial).toBe("");
	});

	it("handles empty string", () => {
		expect(splitTrailingPartialEscape("")).toEqual({ head: "", partial: "" });
	});
});

describe("escapeXmlText", () => {
	it("returns text without special chars unchanged", () => {
		expect(escapeXmlText("hello world")).toBe("hello world");
	});

	it("escapes ampersand", () => {
		expect(escapeXmlText("a&b")).toBe("a&amp;b");
	});

	it("escapes less-than", () => {
		expect(escapeXmlText("a<b")).toBe("a&lt;b");
	});

	it("escapes greater-than", () => {
		expect(escapeXmlText("a>b")).toBe("a&gt;b");
	});

	it("escapes all three special chars", () => {
		expect(escapeXmlText("a<b>&c")).toBe("a&lt;b&gt;&amp;c");
	});

	it("handles empty string", () => {
		expect(escapeXmlText("")).toBe("");
	});

	it("does not escape quotes", () => {
		expect(escapeXmlText('a"b')).toBe('a"b');
	});

	it("returns same reference when no escaping needed", () => {
		const text = "hello";
		expect(escapeXmlText(text)).toBe(text);
	});
});

describe("escapeXmlAttribute", () => {
	it("returns text without special chars unchanged", () => {
		expect(escapeXmlAttribute("hello")).toBe("hello");
	});

	it("escapes ampersand", () => {
		expect(escapeXmlAttribute("a&b")).toBe("a&amp;b");
	});

	it("escapes less-than", () => {
		expect(escapeXmlAttribute("a<b")).toBe("a&lt;b");
	});

	it("escapes greater-than", () => {
		expect(escapeXmlAttribute("a>b")).toBe("a&gt;b");
	});

	it("escapes double quote", () => {
		expect(escapeXmlAttribute('a"b')).toBe("a&quot;b");
	});

	it("escapes all four special chars", () => {
		expect(escapeXmlAttribute('a<b>"&c')).toBe("a&lt;b&gt;&quot;&amp;c");
	});

	it("handles empty string", () => {
		expect(escapeXmlAttribute("")).toBe("");
	});

	it("returns same reference when no escaping needed", () => {
		const text = "hello";
		expect(escapeXmlAttribute(text)).toBe(text);
	});
});
