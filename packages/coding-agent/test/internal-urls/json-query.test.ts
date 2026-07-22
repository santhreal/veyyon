import { describe, expect, it } from "bun:test";
import { applyQuery, parseQuery, pathToQuery } from "@veyyon/coding-agent/internal-urls/json-query";

/**
 * json-query parses the jq-like extraction queries used by agent:// URLs. It had
 * no test. Besides pinning the documented syntax, these tests lock a real fix: the
 * bracket scanner used a quote-unaware indexOf("]"), so a bracket-quoted key that
 * contains "]" (the exact arbitrary-key case bracket notation exists for) was
 * mis-parsed and did not round-trip through pathToQuery. The regression cases below
 * fail against the old first-"]" scan.
 */

describe("parseQuery", () => {
	it("tokenizes dotted and indexed access", () => {
		expect(parseQuery(".foo.bar[0]")).toEqual(["foo", "bar", 0]);
	});

	it("reads a quoted bracket key", () => {
		expect(parseQuery(".foo['special-key']")).toEqual(["foo", "special-key"]);
	});

	it("treats a bare bracket integer as a numeric index and a bareword as a string", () => {
		expect(parseQuery("[10]")).toEqual([10]);
		expect(parseQuery("[foo]")).toEqual(["foo"]);
	});

	it("returns an empty token list for an empty or root query", () => {
		expect(parseQuery("")).toEqual([]);
		expect(parseQuery(".")).toEqual([]);
	});

	it("keeps a ']' that lives inside a quoted key (regression)", () => {
		expect(parseQuery('["a]b"]')).toEqual(["a]b"]);
		expect(parseQuery('.foo["a]b"].baz')).toEqual(["foo", "a]b", "baz"]);
	});

	it("unescapes a backslash-escaped quote inside a quoted key", () => {
		expect(parseQuery("['it\\'s']")).toEqual(["it's"]);
	});

	it("throws on a missing close bracket", () => {
		expect(() => parseQuery("[0")).toThrow("missing ]");
	});

	it("throws on empty brackets", () => {
		expect(() => parseQuery("[]")).toThrow("empty []");
	});

	it("throws on an unterminated quoted key", () => {
		expect(() => parseQuery('["abc]')).toThrow("unterminated quoted key");
	});
});

describe("applyQuery", () => {
	const data = { foo: { bar: [1, 2, 3] }, "a]b": 5 };

	it("resolves a nested path to its value", () => {
		expect(applyQuery(data, ".foo.bar[0]")).toBe(1);
	});

	it("returns undefined for an out-of-range index", () => {
		expect(applyQuery(data, ".foo.bar[5]")).toBeUndefined();
	});

	it("short-circuits to undefined through a null link", () => {
		expect(applyQuery({ a: null }, ".a.b")).toBeUndefined();
	});

	it("returns undefined when a numeric index targets a non-array", () => {
		expect(applyQuery({ x: 1 }, "[0]")).toBeUndefined();
	});

	it("indexes a top-level array", () => {
		expect(applyQuery([10, 20, 30], "[1]")).toBe(20);
	});

	it("resolves a quoted key containing ']' end to end (regression)", () => {
		expect(applyQuery(data, '["a]b"]')).toBe(5);
	});
});

describe("pathToQuery", () => {
	it("converts a path form to dotted/indexed query syntax", () => {
		expect(pathToQuery("/foo/bar/0")).toBe(".foo.bar[0]");
	});

	it("treats root and empty paths as an empty query", () => {
		expect(pathToQuery("/")).toBe("");
		expect(pathToQuery("")).toBe("");
	});

	it("drops empty segments from extra or trailing slashes", () => {
		expect(pathToQuery("/foo//bar/")).toBe(".foo.bar");
	});

	it("uses bracket-quote notation for non-identifier segments", () => {
		expect(pathToQuery("/a b")).toBe("['a b']");
	});

	it("URL-decodes a segment before deciding its form", () => {
		expect(pathToQuery("/%2Ffoo")).toBe("['/foo']");
	});

	it("round-trips a key containing ']' through applyQuery (regression)", () => {
		const query = pathToQuery("/a]b");
		expect(query).toBe("['a]b']");
		expect(applyQuery({ "a]b": 7 }, query)).toBe(7);
	});

	it("round-trips a key containing an apostrophe through applyQuery", () => {
		const query = pathToQuery("/it's");
		expect(applyQuery({ "it's": 9 }, query)).toBe(9);
	});
});
