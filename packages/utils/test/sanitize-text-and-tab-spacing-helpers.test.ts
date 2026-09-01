import { describe, expect, it } from "bun:test";
import { escapeXmlAttribute, escapeXmlText, sanitizeText, splitTrailingPartialEscape } from "../src/sanitize-text";
import { DEFAULT_TAB_WIDTH, MAX_TAB_WIDTH, MIN_TAB_WIDTH } from "../src/tab-spacing";

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
		expect(sanitizeText("\x1b[31mred\x1b[0m")).toBe("red");
	});
	it("handles text with no control chars", () => {
		expect(sanitizeText("normal text 123")).toBe("normal text 123");
	});
	it("handles unicode text", () => {
		expect(sanitizeText("你好世界")).toBe("你好世界");
	});
	it("normalizes lone surrogates", () => {
		const result = sanitizeText("a\uD800b");
		expect(result).toBe("ab");
	});
});

describe("splitTrailingPartialEscape", () => {
	it("returns whole text as head when no escape char", () => {
		expect(splitTrailingPartialEscape("hello")).toEqual({ head: "hello", partial: "" });
	});
	it("returns whole text as head when no trailing partial", () => {
		expect(splitTrailingPartialEscape("\x1b[31mred\x1b[0m")).toEqual({
			head: "\x1b[31mred\x1b[0m",
			partial: "",
		});
	});
	it("splits trailing incomplete CSI sequence", () => {
		const result = splitTrailingPartialEscape("text\x1b[31");
		expect(result.head).toBe("text");
		expect(result.partial).toBe("\x1b[31");
	});
	it("splits trailing incomplete OSC sequence", () => {
		const result = splitTrailingPartialEscape("text\x1b]0;title");
		expect(result.head).toBe("text");
		expect(result.partial).toBe("\x1b]0;title");
	});
	it("handles empty string", () => {
		expect(splitTrailingPartialEscape("")).toEqual({ head: "", partial: "" });
	});
	it("handles only escape char", () => {
		const result = splitTrailingPartialEscape("\x1b");
		expect(result.partial).toBe("\x1b");
	});
	it("completes OSC with BEL", () => {
		const result = splitTrailingPartialEscape("text\x1b]0;title\x07");
		expect(result.head).toBe("text\x1b]0;title\x07");
		expect(result.partial).toBe("");
	});
	it("completes OSC with ST (ESC backslash)", () => {
		const result = splitTrailingPartialEscape("text\x1b]0;title\x1b\\");
		expect(result.head).toBe("text\x1b]0;title\x1b\\");
		expect(result.partial).toBe("");
	});
	it("handles simple escape sequence (non-CSI)", () => {
		const result = splitTrailingPartialEscape("text\x1b7");
		expect(result.head).toBe("text\x1b7");
		expect(result.partial).toBe("");
	});
});

describe("escapeXmlText", () => {
	it("returns input unchanged when no special chars", () => {
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
	it("escapes all special chars", () => {
		expect(escapeXmlText("<a>&b")).toBe("&lt;a&gt;&amp;b");
	});
	it("handles empty string", () => {
		expect(escapeXmlText("")).toBe("");
	});
	it("does not escape quotes", () => {
		expect(escapeXmlText('"hello"')).toBe('"hello"');
	});
	it("handles string with no special chars at start", () => {
		expect(escapeXmlText("hello < world")).toBe("hello &lt; world");
	});
});

describe("escapeXmlAttribute", () => {
	it("returns input unchanged when no special chars", () => {
		expect(escapeXmlAttribute("hello world")).toBe("hello world");
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
	it("escapes all special chars", () => {
		expect(escapeXmlAttribute('<a>&b"c')).toBe("&lt;a&gt;&amp;b&quot;c");
	});
	it("handles empty string", () => {
		expect(escapeXmlAttribute("")).toBe("");
	});
	it("does not escape single quote", () => {
		expect(escapeXmlAttribute("hello'world")).toBe("hello'world");
	});
});

describe("tab-spacing constants", () => {
	it("MIN_TAB_WIDTH is 1", () => {
		expect(MIN_TAB_WIDTH).toBe(1);
	});
	it("MAX_TAB_WIDTH is 16", () => {
		expect(MAX_TAB_WIDTH).toBe(16);
	});
	it("DEFAULT_TAB_WIDTH is 3", () => {
		expect(DEFAULT_TAB_WIDTH).toBe(3);
	});
});
