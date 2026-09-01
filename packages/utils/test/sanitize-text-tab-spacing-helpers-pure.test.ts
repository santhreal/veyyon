import { describe, expect, it } from "bun:test";
import { escapeXmlAttribute, escapeXmlText, sanitizeText, splitTrailingPartialEscape } from "../src/sanitize-text";
import { DEFAULT_TAB_WIDTH, MAX_TAB_WIDTH, MIN_TAB_WIDTH } from "../src/tab-spacing";

describe("sanitizeText", () => {
	it("returns plain text unchanged", () => {
		expect(sanitizeText("hello world")).toBe("hello world");
	});
	it("strips ANSI escape sequences", () => {
		expect(sanitizeText("\x1b[31mred\x1b[0m text")).toBe("red text");
	});
	it("strips control characters (except tab and newline)", () => {
		expect(sanitizeText("hello\x00world")).toBe("helloworld");
		expect(sanitizeText("hello\x07world")).toBe("helloworld");
	});
	it("preserves tabs and newlines", () => {
		expect(sanitizeText("hello\tworld\n")).toBe("hello\tworld\n");
	});
	it("strips DEL (0x7f)", () => {
		expect(sanitizeText("hello\x7fworld")).toBe("helloworld");
	});
	it("strips C1 controls (0x80-0x9f)", () => {
		expect(sanitizeText("hello\x80world")).toBe("helloworld");
	});
	it("handles empty string", () => {
		expect(sanitizeText("")).toBe("");
	});
	it("handles text with only ANSI", () => {
		expect(sanitizeText("\x1b[31m\x1b[0m")).toBe("");
	});
	it("removes lone surrogates", () => {
		const lone = String.fromCharCode(0xd800);
		expect(sanitizeText(`hello${lone}world`)).toBe("helloworld");
	});
	it("preserves unicode text", () => {
		expect(sanitizeText("héllo wörld")).toBe("héllo wörld");
	});
});

describe("splitTrailingPartialEscape", () => {
	it("returns whole text as head when no ESC", () => {
		const result = splitTrailingPartialEscape("hello world");
		expect(result.head).toBe("hello world");
		expect(result.partial).toBe("");
	});
	it("splits complete CSI sequence into head", () => {
		const result = splitTrailingPartialEscape("text\x1b[31mred\x1b[0m");
		expect(result.head).toBe("text\x1b[31mred\x1b[0m");
		expect(result.partial).toBe("");
	});
	it("retains incomplete CSI as partial", () => {
		const result = splitTrailingPartialEscape("text\x1b[31");
		expect(result.head).toBe("text");
		expect(result.partial).toBe("\x1b[31");
	});
	it("retains incomplete OSC as partial", () => {
		const result = splitTrailingPartialEscape("text\x1b]0;title");
		expect(result.head).toBe("text");
		expect(result.partial).toBe("\x1b]0;title");
	});
	it("completes OSC with BEL", () => {
		const result = splitTrailingPartialEscape("text\x1b]0;title\x07");
		expect(result.head).toBe("text\x1b]0;title\x07");
		expect(result.partial).toBe("");
	});
	it("completes OSC with ESC \\", () => {
		const result = splitTrailingPartialEscape("text\x1b]0;title\x1b\\");
		expect(result.head).toBe("text\x1b]0;title\x1b\\");
		expect(result.partial).toBe("");
	});
	it("handles empty string", () => {
		const result = splitTrailingPartialEscape("");
		expect(result.head).toBe("");
		expect(result.partial).toBe("");
	});
	it("handles lone ESC at end", () => {
		const result = splitTrailingPartialEscape("text\x1b");
		expect(result.head).toBe("text");
		expect(result.partial).toBe("\x1b");
	});
	it("handles ESC followed by non-sequence char (N is not a string starter)", () => {
		const result = splitTrailingPartialEscape("text\x1bNmore");
		expect(result.head).toBe("text\x1bNmore");
		expect(result.partial).toBe("");
	});
});

describe("escapeXmlText", () => {
	it("returns input unchanged when no special chars", () => {
		expect(escapeXmlText("hello world")).toBe("hello world");
	});
	it("escapes & as &amp;", () => {
		expect(escapeXmlText("a&b")).toBe("a&amp;b");
	});
	it("escapes < as &lt;", () => {
		expect(escapeXmlText("a<b")).toBe("a&lt;b");
	});
	it("escapes > as &gt;", () => {
		expect(escapeXmlText("a>b")).toBe("a&gt;b");
	});
	it("escapes all three special chars", () => {
		expect(escapeXmlText("a<b>&c")).toBe("a&lt;b&gt;&amp;c");
	});
	it("does not escape quotes", () => {
		expect(escapeXmlText('"hello"')).toBe('"hello"');
	});
	it("handles empty string", () => {
		expect(escapeXmlText("")).toBe("");
	});
	it("returns same reference when nothing to escape", () => {
		const input = "hello";
		expect(escapeXmlText(input)).toBe(input);
	});
	it("handles string with only special chars", () => {
		expect(escapeXmlText("<<<")).toBe("&lt;&lt;&lt;");
	});
});

describe("escapeXmlAttribute", () => {
	it("returns input unchanged when no special chars", () => {
		expect(escapeXmlAttribute("hello world")).toBe("hello world");
	});
	it("escapes & as &amp;", () => {
		expect(escapeXmlAttribute("a&b")).toBe("a&amp;b");
	});
	it("escapes < as &lt;", () => {
		expect(escapeXmlAttribute("a<b")).toBe("a&lt;b");
	});
	it("escapes > as &gt;", () => {
		expect(escapeXmlAttribute("a>b")).toBe("a&gt;b");
	});
	it("escapes double quote as &quot;", () => {
		expect(escapeXmlAttribute('a"b')).toBe("a&quot;b");
	});
	it("escapes all four special chars", () => {
		expect(escapeXmlAttribute('a<b>&"c')).toBe("a&lt;b&gt;&amp;&quot;c");
	});
	it("handles empty string", () => {
		expect(escapeXmlAttribute("")).toBe("");
	});
	it("returns same reference when nothing to escape", () => {
		const input = "hello";
		expect(escapeXmlAttribute(input)).toBe(input);
	});
	it("handles string with only quotes", () => {
		expect(escapeXmlAttribute('"""')).toBe("&quot;&quot;&quot;");
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
