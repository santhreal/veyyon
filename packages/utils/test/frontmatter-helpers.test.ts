import { describe, expect, it } from "bun:test";
import {
	FLOW_OR_EXPLICIT_VALUE_START,
	normalizeKeys,
	PLAIN_SCALAR_KEY_VALUE,
	parseYamlRecord,
	quoteAmbiguousPlainScalars,
	stripHtmlComments,
} from "../src/frontmatter-helpers";

describe("stripHtmlComments", () => {
	it("removes a simple HTML comment", () => {
		expect(stripHtmlComments("hello <!-- world --> goodbye")).toBe("hello  goodbye");
	});

	it("removes multi-line HTML comments", () => {
		const input = "before<!--\nmulti\nline\n-->after";
		expect(stripHtmlComments(input)).toBe("beforeafter");
	});

	it("removes multiple comments", () => {
		expect(stripHtmlComments("a<!-- 1 -->b<!-- 2 -->c")).toBe("abc");
	});

	it("handles empty comment", () => {
		expect(stripHtmlComments("a<!---->b")).toBe("ab");
	});

	it("handles no comments", () => {
		expect(stripHtmlComments("plain text")).toBe("plain text");
	});

	it("handles empty string", () => {
		expect(stripHtmlComments("")).toBe("");
	});

	it("handles unclosed comment (non-greedy to end)", () => {
		// The regex is non-greedy [\s\S]*?, so an unclosed comment matches nothing
		expect(stripHtmlComments("text <!-- unclosed")).toBe("text <!-- unclosed");
	});

	it("handles nested-looking comments", () => {
		// <!-- <!-- --> is treated as one comment ending at first -->
		expect(stripHtmlComments("a<!-- <!-- -->b")).toBe("ab");
	});
});

describe("normalizeKeys", () => {
	it("converts kebab-case keys to camelCase", () => {
		const input = { "foo-bar": 1, "baz-qux": 2 };
		const result = normalizeKeys(input) as unknown as Record<string, number>;
		expect(result).toEqual({ fooBar: 1, bazQux: 2 });
	});

	it("leaves camelCase keys unchanged", () => {
		const input = { fooBar: 1, bazQux: 2 };
		const result = normalizeKeys(input);
		expect(result).toBe(input);
	});

	it("handles nested objects", () => {
		const input = { "outer-key": { "inner-key": "value" } };
		const result = normalizeKeys(input) as unknown as Record<string, Record<string, string>>;
		expect(result).toEqual({ outerKey: { innerKey: "value" } });
	});

	it("handles arrays", () => {
		const input = [{ "key-name": 1 }, { "key-name": 2 }];
		const result = normalizeKeys(input) as unknown as Array<Record<string, number>>;
		expect(result).toEqual([{ keyName: 1 }, { keyName: 2 }]);
	});

	it("handles null", () => {
		expect(normalizeKeys(null)).toBe(null);
	});

	it("handles primitives", () => {
		expect(normalizeKeys(42)).toBe(42);
		expect(normalizeKeys("hello")).toBe("hello");
		expect(normalizeKeys(true)).toBe(true);
		expect(normalizeKeys(undefined)).toBe(undefined);
	});

	it("handles empty object", () => {
		const input: Record<string, unknown> = {};
		expect(normalizeKeys(input)).toBe(input);
	});

	it("handles mixed keys", () => {
		const input = { "kebab-key": 1, camelKey: 2, "another-one": 3 };
		const result = normalizeKeys(input) as unknown as Record<string, number>;
		expect(result).toEqual({ kebabKey: 1, camelKey: 2, anotherOne: 3 });
	});

	it("handles deeply nested structures", () => {
		const input = {
			"level-one": {
				"level-two": {
					"level-three": "deep",
				},
			},
		};
		const result = normalizeKeys(input) as unknown as Record<string, Record<string, Record<string, string>>>;
		expect(result).toEqual({
			levelOne: {
				levelTwo: {
					levelThree: "deep",
				},
			},
		});
	});

	it("handles arrays of objects with nested keys", () => {
		const input = {
			items: [{ "item-key": "a" }, { "item-key": "b" }],
		};
		const result = normalizeKeys(input) as unknown as { items: Array<Record<string, string>> };
		expect(result).toEqual({
			items: [{ itemKey: "a" }, { itemKey: "b" }],
		});
	});

	it("returns same reference when no keys need changing", () => {
		const input = { foo: 1, bar: 2 };
		expect(normalizeKeys(input)).toBe(input);
	});
});

describe("PLAIN_SCALAR_KEY_VALUE regex", () => {
	it("matches simple key: value", () => {
		const match = "key: value".match(PLAIN_SCALAR_KEY_VALUE);
		expect(match).not.toBeNull();
	});

	it("matches indented key: value", () => {
		const match = "  key: value".match(PLAIN_SCALAR_KEY_VALUE);
		expect(match).not.toBeNull();
	});

	it("matches key with underscores", () => {
		const match = "my_key: value".match(PLAIN_SCALAR_KEY_VALUE);
		expect(match).not.toBeNull();
	});

	it("does not match empty value", () => {
		const match = "key: ".match(PLAIN_SCALAR_KEY_VALUE);
		expect(match).toBeNull();
	});

	it("does not match lines without colon", () => {
		const match = "just text".match(PLAIN_SCALAR_KEY_VALUE);
		expect(match).toBeNull();
	});
});

describe("FLOW_OR_EXPLICIT_VALUE_START", () => {
	it("contains quote characters", () => {
		expect(FLOW_OR_EXPLICIT_VALUE_START.has('"')).toBe(true);
		expect(FLOW_OR_EXPLICIT_VALUE_START.has("'")).toBe(true);
	});

	it("contains flow markers", () => {
		expect(FLOW_OR_EXPLICIT_VALUE_START.has("[")).toBe(true);
		expect(FLOW_OR_EXPLICIT_VALUE_START.has("{")).toBe(true);
	});

	it("contains block scalars", () => {
		expect(FLOW_OR_EXPLICIT_VALUE_START.has("|")).toBe(true);
		expect(FLOW_OR_EXPLICIT_VALUE_START.has(">")).toBe(true);
	});

	it("contains YAML tags and anchors", () => {
		expect(FLOW_OR_EXPLICIT_VALUE_START.has("!")).toBe(true);
		expect(FLOW_OR_EXPLICIT_VALUE_START.has("&")).toBe(true);
		expect(FLOW_OR_EXPLICIT_VALUE_START.has("*")).toBe(true);
	});

	it("contains comment marker", () => {
		expect(FLOW_OR_EXPLICIT_VALUE_START.has("#")).toBe(true);
	});

	it("does not contain letters or digits", () => {
		expect(FLOW_OR_EXPLICIT_VALUE_START.has("a")).toBe(false);
		expect(FLOW_OR_EXPLICIT_VALUE_START.has("1")).toBe(false);
	});
});

describe("quoteAmbiguousPlainScalars", () => {
	it("returns undefined when no quoting needed", () => {
		expect(quoteAmbiguousPlainScalars("key: value\nother: data")).toBeUndefined();
	});

	it("returns undefined for simple values", () => {
		expect(quoteAmbiguousPlainScalars("name: hello")).toBeUndefined();
	});

	it("quotes values containing colon-space", () => {
		const result = quoteAmbiguousPlainScalars("url: http://example.com: foo");
		expect(result).toContain('"http://example.com: foo"');
	});

	it("does not quote values that already start with a flow marker", () => {
		expect(quoteAmbiguousPlainScalars('key: "value: with colon"')).toBeUndefined();
		expect(quoteAmbiguousPlainScalars("key: [a: b]")).toBeUndefined();
	});

	it("handles multiple lines with mixed needs", () => {
		const input = "name: hello\nurl: http://example.com: 8080\nport: 8080";
		const result = quoteAmbiguousPlainScalars(input);
		expect(result).toContain('"http://example.com: 8080"');
		expect(result).toContain("name: hello");
		expect(result).toContain("port: 8080");
	});

	it("handles empty input", () => {
		expect(quoteAmbiguousPlainScalars("")).toBeUndefined();
	});

	it("does not quote values without colon-space", () => {
		expect(quoteAmbiguousPlainScalars("key: value:with:colons")).toBeUndefined();
	});
});

describe("parseYamlRecord", () => {
	it("parses simple YAML key-value", () => {
		const result = parseYamlRecord("key: value");
		expect(result).toEqual({ key: "value" });
	});

	it("parses multiple keys", () => {
		const result = parseYamlRecord("a: 1\nb: 2\nc: 3");
		expect(result).toEqual({ a: 1, b: 2, c: 3 });
	});

	it("returns null for empty string", () => {
		expect(parseYamlRecord("")).toBeNull();
	});

	it("returns null for YAML that parses to non-object", () => {
		expect(parseYamlRecord("just a string")).toBeNull();
		expect(parseYamlRecord("- item1\n- item2")).toBeNull();
	});

	it("returns null for null YAML", () => {
		expect(parseYamlRecord("---\nnull")).toBeNull();
	});

	it("parses nested objects", () => {
		const result = parseYamlRecord("outer:\n  inner: value");
		expect(result).toEqual({ outer: { inner: "value" } });
	});

	it("parses arrays as values", () => {
		const result = parseYamlRecord("items:\n  - a\n  - b");
		expect(result).toEqual({ items: ["a", "b"] });
	});

	it("converts tabs to spaces before parsing", () => {
		const result = parseYamlRecord("key:\tvalue");
		expect(result).toEqual({ key: "value" });
	});

	it("parses numeric values", () => {
		const result = parseYamlRecord("count: 42\nratio: 3.14");
		expect(result).toEqual({ count: 42, ratio: 3.14 });
	});

	it("parses boolean values", () => {
		const result = parseYamlRecord("yes: true\nno: false");
		expect(result).toEqual({ yes: true, no: false });
	});

	it("parses null values", () => {
		const result = parseYamlRecord("missing: null");
		expect(result).toEqual({ missing: null });
	});
});
