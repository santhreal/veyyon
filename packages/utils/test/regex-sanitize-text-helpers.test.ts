import { describe, expect, it } from "bun:test";
import { ALNUM_RE, DATE_ONLY_RE, escapeRegExp, hasAlphanumeric, isDateOnly, isUuid, UUID_RE } from "../src/regex";
import { escapeXmlAttribute, escapeXmlText, sanitizeText, splitTrailingPartialEscape } from "../src/sanitize-text";

describe("escapeRegExp", () => {
	it("escapes dot", () => {
		expect(escapeRegExp("a.b")).toBe("a\\.b");
	});

	it("escapes all special chars", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: regex special chars fixture contains literal ${} syntax
		expect(escapeRegExp(".*+?^${}()|[]\\")).toBe("\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\");
	});

	it("does not escape alphanumeric", () => {
		expect(escapeRegExp("abc123")).toBe("abc123");
	});

	it("handles empty string", () => {
		expect(escapeRegExp("")).toBe("");
	});

	it("does not escape hyphen", () => {
		expect(escapeRegExp("a-b")).toBe("a-b");
	});
});

describe("ALNUM_RE", () => {
	it("matches alphanumeric characters", () => {
		expect(ALNUM_RE.test("a")).toBe(true);
		expect(ALNUM_RE.test("1")).toBe(true);
	});

	it("does not match non-alphanumeric", () => {
		expect(ALNUM_RE.test("-")).toBe(false);
		expect(ALNUM_RE.test(" ")).toBe(false);
		expect(ALNUM_RE.test("!")).toBe(false);
	});
});

describe("hasAlphanumeric", () => {
	it("returns true for alphanumeric strings", () => {
		expect(hasAlphanumeric("hello")).toBe(true);
		expect(hasAlphanumeric("123")).toBe(true);
		expect(hasAlphanumeric("a1")).toBe(true);
	});

	it("returns false for non-alphanumeric strings", () => {
		expect(hasAlphanumeric("---")).toBe(false);
		expect(hasAlphanumeric("   ")).toBe(false);
		expect(hasAlphanumeric("!@#")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(hasAlphanumeric("")).toBe(false);
	});

	it("handles unicode alphanumeric", () => {
		expect(hasAlphanumeric("café")).toBe(true);
		expect(hasAlphanumeric("日本語")).toBe(true);
	});
});

describe("UUID_RE", () => {
	it("matches valid UUID", () => {
		expect(UUID_RE.test("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
	});

	it("matches uppercase UUID", () => {
		expect(UUID_RE.test("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
	});

	it("does not match invalid UUID", () => {
		expect(UUID_RE.test("not-a-uuid")).toBe(false);
		expect(UUID_RE.test("550e8400-e29b-41d4-a716")).toBe(false);
	});

	it("does not match UUID with extra characters", () => {
		expect(UUID_RE.test("550e8400-e29b-41d4-a716-446655440000extra")).toBe(false);
	});
});

describe("isUuid", () => {
	it("returns true for valid UUID", () => {
		expect(isUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
	});

	it("returns false for invalid UUID", () => {
		expect(isUuid("not-a-uuid")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isUuid("")).toBe(false);
	});
});

describe("DATE_ONLY_RE", () => {
	it("matches valid date format", () => {
		expect(DATE_ONLY_RE.test("2024-01-15")).toBe(true);
		expect(DATE_ONLY_RE.test("1999-12-31")).toBe(true);
	});

	it("does not match invalid date format", () => {
		expect(DATE_ONLY_RE.test("2024/01/15")).toBe(false);
		expect(DATE_ONLY_RE.test("2024-1-15")).toBe(false);
		expect(DATE_ONLY_RE.test("24-01-15")).toBe(false);
	});

	it("does not match datetime", () => {
		expect(DATE_ONLY_RE.test("2024-01-15T10:30:00")).toBe(false);
	});
});

describe("isDateOnly", () => {
	it("returns true for valid date", () => {
		expect(isDateOnly("2024-01-15")).toBe(true);
	});

	it("returns false for invalid date", () => {
		expect(isDateOnly("not-a-date")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isDateOnly("")).toBe(false);
	});
});

describe("sanitizeText", () => {
	it("returns plain text unchanged", () => {
		expect(sanitizeText("hello world")).toBe("hello world");
	});

	it("removes control characters", () => {
		expect(sanitizeText("hello\x00world")).toBe("helloworld");
		expect(sanitizeText("hello\x07world")).toBe("helloworld");
	});

	it("removes DEL character", () => {
		expect(sanitizeText("hello\x7Fworld")).toBe("helloworld");
	});

	it("preserves tab and newline", () => {
		expect(sanitizeText("hello\tworld\n")).toBe("hello\tworld\n");
	});

	it("strips ANSI escape sequences", () => {
		expect(sanitizeText("\x1b[31mred\x1b[0m")).toBe("red");
	});

	it("handles empty string", () => {
		expect(sanitizeText("")).toBe("");
	});

	it("handles text with only control chars", () => {
		expect(sanitizeText("\x00\x01\x02")).toBe("");
	});

	it("handles C1 control characters", () => {
		expect(sanitizeText("hello\x9Fworld")).toBe("helloworld");
	});
});

describe("splitTrailingPartialEscape", () => {
	it("returns whole text as head when no escape char", () => {
		const result = splitTrailingPartialEscape("plain text");
		expect(result.head).toBe("plain text");
		expect(result.partial).toBe("");
	});

	it("returns whole text as head when no partial escape", () => {
		const result = splitTrailingPartialEscape("\x1b[31mcomplete\x1b[0m");
		expect(result.head).toBe("\x1b[31mcomplete\x1b[0m");
		expect(result.partial).toBe("");
	});

	it("splits trailing incomplete CSI sequence", () => {
		const result = splitTrailingPartialEscape("text\x1b[3");
		expect(result.head).toBe("text");
		expect(result.partial).toBe("\x1b[3");
	});

	it("splits trailing incomplete OSC sequence", () => {
		const result = splitTrailingPartialEscape("text\x1b]0;");
		expect(result.head).toBe("text");
		expect(result.partial).toBe("\x1b]0;");
	});

	it("handles empty string", () => {
		const result = splitTrailingPartialEscape("");
		expect(result.head).toBe("");
		expect(result.partial).toBe("");
	});

	it("handles complete escape in middle", () => {
		const result = splitTrailingPartialEscape("a\x1b[31mb\x1b[0mc");
		expect(result.head).toBe("a\x1b[31mb\x1b[0mc");
		expect(result.partial).toBe("");
	});
});

describe("escapeXmlText", () => {
	it("escapes ampersand", () => {
		expect(escapeXmlText("a&b")).toBe("a&amp;b");
	});

	it("escapes less-than", () => {
		expect(escapeXmlText("a<b")).toBe("a&lt;b");
	});

	it("escapes greater-than", () => {
		expect(escapeXmlText("a>b")).toBe("a&gt;b");
	});

	it("does not escape quotes", () => {
		expect(escapeXmlText('"hello"')).toBe('"hello"');
	});

	it("returns unchanged when no special chars", () => {
		expect(escapeXmlText("plain text")).toBe("plain text");
	});

	it("handles empty string", () => {
		expect(escapeXmlText("")).toBe("");
	});

	it("escapes multiple special chars", () => {
		expect(escapeXmlText("a<b>&c")).toBe("a&lt;b&gt;&amp;c");
	});
});

describe("escapeXmlAttribute", () => {
	it("escapes ampersand", () => {
		expect(escapeXmlAttribute("a&b")).toBe("a&amp;b");
	});

	it("escapes less-than", () => {
		expect(escapeXmlAttribute("a<b")).toBe("a&lt;b");
	});

	it("escapes greater-than", () => {
		expect(escapeXmlAttribute("a>b")).toBe("a&gt;b");
	});

	it("escapes double quotes", () => {
		expect(escapeXmlAttribute('"hello"')).toBe("&quot;hello&quot;");
	});

	it("returns unchanged when no special chars", () => {
		expect(escapeXmlAttribute("plain text")).toBe("plain text");
	});

	it("handles empty string", () => {
		expect(escapeXmlAttribute("")).toBe("");
	});

	it("escapes all special chars together", () => {
		expect(escapeXmlAttribute('a<b>"&c')).toBe("a&lt;b&gt;&quot;&amp;c");
	});
});
