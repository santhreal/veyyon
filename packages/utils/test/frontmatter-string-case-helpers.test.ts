import { describe, expect, it } from "bun:test";
import { FrontmatterError, parseFrontmatter } from "../src/frontmatter";
import {
	normalizeKeys,
	parseYamlRecord,
	quoteAmbiguousPlainScalars,
	stripHtmlComments,
} from "../src/frontmatter-helpers";
import { kebabToCamel, titleCaseSentence, titleCaseWords } from "../src/string-case";

describe("kebabToCamel", () => {
	it("converts simple kebab-case to camelCase", () => {
		expect(kebabToCamel("thinking-level")).toBe("thinkingLevel");
	});

	it("converts multi-word kebab-case", () => {
		expect(kebabToCamel("a-b-c-d")).toBe("aBCD");
	});

	it("returns unchanged when no hyphen", () => {
		expect(kebabToCamel("already")).toBe("already");
	});

	it("leaves uppercase after hyphen unchanged", () => {
		expect(kebabToCamel("X-Header")).toBe("X-Header");
	});

	it("handles leading hyphen", () => {
		expect(kebabToCamel("-test")).toBe("Test");
	});

	it("handles trailing hyphen", () => {
		expect(kebabToCamel("test-")).toBe("test-");
	});

	it("handles empty string", () => {
		expect(kebabToCamel("")).toBe("");
	});

	it("handles consecutive hyphens", () => {
		expect(kebabToCamel("a--b")).toBe("a-B");
	});
});

describe("titleCaseWords", () => {
	it("capitalizes each word", () => {
		expect(titleCaseWords("hello world")).toBe("Hello World");
	});

	it("handles single word", () => {
		expect(titleCaseWords("hello")).toBe("Hello");
	});

	it("handles empty string", () => {
		expect(titleCaseWords("")).toBe("");
	});

	it("handles multiple spaces", () => {
		expect(titleCaseWords("hello   world")).toBe("Hello World");
	});

	it("handles leading/trailing whitespace", () => {
		expect(titleCaseWords("  hello  ")).toBe("Hello");
	});

	it("preserves acronyms in rest of word", () => {
		expect(titleCaseWords("hello WORLD")).toBe("Hello WORLD");
	});
});

describe("titleCaseSentence", () => {
	it("capitalizes first letter", () => {
		expect(titleCaseSentence("hello world")).toBe("Hello world");
	});

	it("handles empty string", () => {
		expect(titleCaseSentence("")).toBe("");
	});

	it("handles whitespace-only string", () => {
		expect(titleCaseSentence("   ")).toBe("");
	});

	it("preserves rest of sentence casing", () => {
		expect(titleCaseSentence("hello WORLD")).toBe("Hello WORLD");
	});

	it("handles already capitalized", () => {
		expect(titleCaseSentence("Hello")).toBe("Hello");
	});

	it("trims leading/trailing whitespace", () => {
		expect(titleCaseSentence("  hello  ")).toBe("Hello");
	});
});

describe("stripHtmlComments", () => {
	it("removes single-line HTML comment", () => {
		expect(stripHtmlComments("hello <!-- comment --> world")).toBe("hello  world");
	});

	it("removes multi-line HTML comment", () => {
		expect(stripHtmlComments("a <!-- multi\nline\ncomment --> b")).toBe("a  b");
	});

	it("removes multiple comments", () => {
		expect(stripHtmlComments("<!-- one -->middle<!-- two -->")).toBe("middle");
	});

	it("returns unchanged when no comments", () => {
		expect(stripHtmlComments("plain text")).toBe("plain text");
	});

	it("handles empty string", () => {
		expect(stripHtmlComments("")).toBe("");
	});

	it("handles comment at start", () => {
		expect(stripHtmlComments("<!-- start -->text")).toBe("text");
	});

	it("handles comment at end", () => {
		expect(stripHtmlComments("text<!-- end -->")).toBe("text");
	});
});

describe("normalizeKeys", () => {
	it("converts kebab-case keys to camelCase", () => {
		const input = { "my-key": 1, other: 2 };
		expect(normalizeKeys(input) as Record<string, unknown>).toEqual({ myKey: 1, other: 2 });
	});

	it("returns null unchanged", () => {
		expect(normalizeKeys(null)).toBe(null);
	});

	it("returns primitives unchanged", () => {
		expect(normalizeKeys(42)).toBe(42);
		expect(normalizeKeys("hello")).toBe("hello");
		expect(normalizeKeys(undefined)).toBe(undefined);
	});

	it("normalizes nested objects", () => {
		const input = { outer: { "inner-key": "value" } };
		expect(normalizeKeys(input) as Record<string, unknown>).toEqual({ outer: { innerKey: "value" } });
	});

	it("normalizes arrays of objects", () => {
		const input = [{ "key-one": 1 }, { "key-two": 2 }];
		expect(normalizeKeys(input) as unknown[]).toEqual([{ keyOne: 1 }, { keyTwo: 2 }]);
	});

	it("returns same reference when no changes needed", () => {
		const input = { already: 1, fine: 2 };
		expect(normalizeKeys(input)).toBe(input);
	});

	it("returns same array reference when no changes needed", () => {
		const input = [1, 2, 3];
		expect(normalizeKeys(input)).toBe(input);
	});

	it("handles empty object", () => {
		expect(normalizeKeys({})).toEqual({});
	});

	it("handles empty array", () => {
		expect(normalizeKeys([])).toEqual([]);
	});

	it("handles mixed nested structure", () => {
		const input = { "top-key": [{ "nested-key": "val" }, "plain"] };
		expect(normalizeKeys(input) as Record<string, unknown>).toEqual({
			topKey: [{ nestedKey: "val" }, "plain"],
		});
	});
});

describe("quoteAmbiguousPlainScalars", () => {
	it("returns undefined when no changes needed", () => {
		expect(quoteAmbiguousPlainScalars("key: value")).toBeUndefined();
	});

	it("quotes values containing colon-space", () => {
		const result = quoteAmbiguousPlainScalars("key: value: with colon");
		expect(result).toContain('"value: with colon"');
	});

	it("does not quote values starting with quote", () => {
		expect(quoteAmbiguousPlainScalars('key: "already quoted"')).toBeUndefined();
	});

	it("does not quote values starting with single quote", () => {
		expect(quoteAmbiguousPlainScalars("key: 'already'")).toBeUndefined();
	});

	it("does not quote values starting with bracket", () => {
		expect(quoteAmbiguousPlainScalars("key: [array]")).toBeUndefined();
	});

	it("does not quote values starting with brace", () => {
		expect(quoteAmbiguousPlainScalars("key: {object}")).toBeUndefined();
	});

	it("does not quote values starting with pipe", () => {
		expect(quoteAmbiguousPlainScalars("key: |literal")).toBeUndefined();
	});

	it("does not quote values starting with >", () => {
		expect(quoteAmbiguousPlainScalars("key: >folded")).toBeUndefined();
	});

	it("handles empty string", () => {
		expect(quoteAmbiguousPlainScalars("")).toBeUndefined();
	});

	it("handles multiple lines with some needing quotes", () => {
		const input = "key1: simple\nkey2: value: with colon\nkey3: also simple";
		const result = quoteAmbiguousPlainScalars(input);
		expect(result).toContain('"value: with colon"');
		expect(result).toContain("key1: simple");
	});
});

describe("parseYamlRecord", () => {
	it("parses simple key-value YAML", () => {
		expect(parseYamlRecord("key: value")).toEqual({ key: "value" });
	});

	it("parses multiple keys", () => {
		expect(parseYamlRecord("a: 1\nb: 2")).toEqual({ a: 1, b: 2 });
	});

	it("returns null for empty string", () => {
		expect(parseYamlRecord("")).toBeNull();
	});

	it("returns null for array YAML", () => {
		expect(parseYamlRecord("- item1\n- item2")).toBeNull();
	});

	it("returns null for scalar YAML", () => {
		expect(parseYamlRecord("just a string")).toBeNull();
	});

	it("converts tabs to spaces", () => {
		expect(parseYamlRecord("key:\tvalue")).toEqual({ key: "value" });
	});

	it("parses nested objects", () => {
		expect(parseYamlRecord("outer:\n  inner: value")).toEqual({ outer: { inner: "value" } });
	});

	it("parses boolean values", () => {
		expect(parseYamlRecord("enabled: true")).toEqual({ enabled: true });
	});

	it("parses numeric values", () => {
		expect(parseYamlRecord("count: 42")).toEqual({ count: 42 });
	});

	it("parses null values", () => {
		expect(parseYamlRecord("key: null")).toEqual({ key: null });
	});
});

describe("parseFrontmatter", () => {
	it("returns empty frontmatter and body when no frontmatter delimiter", () => {
		const result = parseFrontmatter("just some text");
		expect(result.frontmatter).toEqual({});
		expect(result.body).toBe("just some text");
	});

	it("parses simple frontmatter", () => {
		const content = "---\nkey: value\n---\nbody text";
		const result = parseFrontmatter(content);
		expect(result.frontmatter).toEqual({ key: "value" });
		expect(result.body).toBe("body text");
	});

	it("normalizes kebab-case keys by default", () => {
		const content = "---\nmy-key: value\n---\nbody";
		const result = parseFrontmatter(content);
		expect(result.frontmatter).toEqual({ myKey: "value" });
	});

	it("does not strip HTML comments when normalize is false", () => {
		const content = "---\nkey: value\n---\n<!-- not stripped -->\nbody";
		const result = parseFrontmatter(content, { normalize: false });
		expect(result.body).toContain("<!-- not stripped -->");
	});

	it("merges fallback values", () => {
		const content = "---\nkey: new\n---\nbody";
		const result = parseFrontmatter(content, { fallback: { other: "fallback" } });
		expect(result.frontmatter).toEqual({ key: "new", other: "fallback" });
	});

	it("returns frontmatter and body when no closing delimiter", () => {
		const content = "---\nkey: value\nno closing";
		const result = parseFrontmatter(content);
		expect(result.body).toContain("no closing");
	});

	it("strips HTML comments before parsing", () => {
		const content = "---\nkey: value\n---\n<!-- comment -->\nbody";
		const result = parseFrontmatter(content);
		expect(result.body).not.toContain("<!-- comment -->");
	});

	it("handles empty frontmatter", () => {
		const content = "---\n---\nbody";
		const result = parseFrontmatter(content);
		expect(result.body).toBe("body");
	});

	it("handles CRLF line endings", () => {
		const content = "---\r\nkey: value\r\n---\r\nbody";
		const result = parseFrontmatter(content);
		expect(result.frontmatter).toEqual({ key: "value" });
	});

	it("falls back to line-by-line parsing on YAML error at warn level", () => {
		const content = "---\nkey: value: with: colons\nbroken: [unclosed\n---\nbody";
		const result = parseFrontmatter(content, { level: "warn" });
		expect(result.body).toBe("body");
	});

	it("throws on YAML error at fatal level", () => {
		const content = "---\nkey: value: with: colons\nbroken: [unclosed\n---\nbody";
		expect(() => parseFrontmatter(content, { level: "fatal" })).toThrow();
	});

	it("handles off level silently", () => {
		const content = "---\nkey: value: with: colons\nbroken: [unclosed\n---\nbody";
		expect(() => parseFrontmatter(content, { level: "off" })).not.toThrow();
	});
});

describe("FrontmatterError", () => {
	it("extends Error", () => {
		const err = new FrontmatterError(new Error("inner"), "test-source");
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("FrontmatterError");
	});

	it("includes source in message", () => {
		const err = new FrontmatterError(new Error("inner"), "my-source");
		expect(err.message).toContain("my-source");
	});

	it("includes source in toString", () => {
		const err = new FrontmatterError(new Error("inner"), "my-source");
		expect(err.toString()).toContain('Source: "my-source"');
	});

	it("handles undefined source", () => {
		const err = new FrontmatterError(new Error("inner"));
		expect(err.message).toContain("undefined");
		expect(err.toString()).not.toContain("Source:");
	});

	it("includes cause in toString", () => {
		const cause = new Error("root cause");
		const err = new FrontmatterError(cause, "src");
		expect(err.cause).toBe(cause);
	});
});
