/**
 * applyQuery is the extraction half of agent:// JSON queries. parseQuery already
 * has a regression for `]` inside a quoted key. This file is the walk, and the
 * walk is where a query stops being syntax and starts being a read of someone
 * else's object.
 *
 * THE DEFECT. `applyQuery` does `current = (current as Record<string, unknown>)[token]`
 * for every non-numeric token. That is an inherited lookup. On a plain JSON
 * object the next token after `.__proto__` is `Object.prototype`, so
 * `.constructor` is `Object` and `.toString` is a function. An agent:// URL that
 * was meant to pick a field can therefore return a function from the prototype
 * chain, which then stringifies as source when the protocol dumps the result.
 *
 * Numeric tokens take a different arm (`Array.isArray` then index). That arm
 * does not look up `"0"` on a non-array, even when the object has that own key.
 * `[00]` tokenizes as the number 0 (`/^\d+$/` then `Number`), so a padded index
 * is not the string key `"00"`.
 *
 * pathToQuery collapses empty segments (`/foo//bar` → `.foo.bar`) and leaves a
 * malformed percent-escape (`%ZZ`) as a quoted key rather than throwing. Both
 * are the bytes an internal URL path actually produces after the router peels
 * the selector.
 *
 * Cases that document the current wrong walk stay red until own-property
 * lookup is the rule.
 */
import { describe, expect, it } from "bun:test";
import { applyQuery, parseQuery, pathToQuery } from "@veyyon/coding-agent/internal-urls/json-query";

describe("applyQuery refuses inherited keys", () => {
	it("does not return Object.prototype for .__proto__ on a JSON object", () => {
		const data = JSON.parse('{"a":1}') as { a: number };
		expect(applyQuery(data, ".__proto__")).toBeUndefined();
	});

	it("does not return Object for .constructor on a JSON object", () => {
		expect(applyQuery({ a: 1 }, ".constructor")).toBeUndefined();
	});

	it("does not return Function.prototype.toString for .toString", () => {
		expect(applyQuery({ a: 1 }, ".toString")).toBeUndefined();
	});

	it("still returns an own key named __proto__ when it was assigned as data", () => {
		const data = Object.create(null) as Record<string, unknown>;
		data.__proto__ = { own: true };
		expect(applyQuery(data, ".__proto__")).toEqual({ own: true });
	});

	it("returns undefined when a numeric index is aimed at a non-array that happens to have a '0' own key", () => {
		expect(applyQuery({ foo: { 0: "x" } }, ".foo[0]")).toBeUndefined();
	});
});

describe("parseQuery numeric brackets are a digit run, not a JS number parse", () => {
	it("tokenizes [00] as the number 0, so applyQuery reads index 0 rather than the key '00'", () => {
		expect(parseQuery("[00]")).toEqual([0]);
		expect(applyQuery(["z", "a"], "[00]")).toBe("z");
		expect(applyQuery({ "00": "padded" }, "[00]")).toBeUndefined();
	});

	it("keeps [-1] as the string '-1', so it cannot secretly mean the last element", () => {
		expect(parseQuery("[-1]")).toEqual(["-1"]);
		expect(applyQuery(["z", "a"], "[-1]")).toBeUndefined();
	});

	it("keeps [1.5] as the string '1.5' and reads that own key", () => {
		expect(parseQuery("[1.5]")).toEqual(["1.5"]);
		expect(applyQuery({ "1.5": "hit" }, "[1.5]")).toBe("hit");
	});

	it("trims spaces inside brackets before deciding digits vs bareword", () => {
		expect(parseQuery("[  3  ]")).toEqual([3]);
		expect(applyQuery(["a", "b", "c", "d"], "[  3  ]")).toBe("d");
	});

	it("preserves spaces that live inside a quoted key", () => {
		expect(parseQuery("[' a ']")).toEqual([" a "]);
		expect(applyQuery({ " a ": 9 }, "[' a ']")).toBe(9);
	});
});

describe("applyQuery stops at null without throwing", () => {
	it("returns undefined when a mid-path value is null", () => {
		expect(applyQuery({ a: null }, ".a.b")).toBeUndefined();
	});

	it("returns undefined when a mid-path value is missing", () => {
		expect(applyQuery({ a: { b: 1 } }, ".a.c.d")).toBeUndefined();
	});

	it("returns undefined when a string is indexed as an object", () => {
		expect(applyQuery({ a: "hi" }, ".a.b")).toBeUndefined();
	});

	it("reads .length on an array because arrays are objects and length is an own key", () => {
		expect(applyQuery([1, 2, 3], ".length")).toBe(3);
	});

	it("does not treat a string as an array for a numeric token", () => {
		expect(applyQuery({ a: "hi" }, ".a[0]")).toBeUndefined();
	});
});

describe("pathToQuery drops empty segments and does not decode a broken escape", () => {
	it("collapses // so /foo//bar is the same query as /foo/bar", () => {
		expect(pathToQuery("/foo//bar")).toBe(".foo.bar");
		expect(pathToQuery("/foo/bar")).toBe(".foo.bar");
	});

	it("leaves %ZZ as a quoted key because decodeURIComponent rejects it", () => {
		expect(pathToQuery("/foo/%ZZ")).toBe(".foo['%ZZ']");
	});

	it("emits [00] for a segment of zeros, which parseQuery then collapses to index 0", () => {
		expect(pathToQuery("/00")).toBe("[00]");
		expect(parseQuery(pathToQuery("/00"))).toEqual([0]);
	});

	it("quotes a segment that is not an identifier, including a quote in the name", () => {
		expect(pathToQuery("/a'b")).toBe("['a\\'b']");
	});

	it("round-trips a bracket character in a path segment through parseQuery", () => {
		const q = pathToQuery("/a]b");
		expect(q).toBe("['a]b']");
		expect(parseQuery(q)).toEqual(["a]b"]);
		expect(applyQuery({ "a]b": 4 }, q)).toBe(4);
	});
});

describe("parseQuery trailing dots and adjacent identifiers", () => {
	it("ignores a trailing dot so .foo. is the same tokens as .foo", () => {
		expect(parseQuery(".foo.")).toEqual(["foo"]);
	});

	it("reads .foo[0]bar as three tokens, not as a syntax error", () => {
		expect(parseQuery(".foo[0]bar")).toEqual(["foo", 0, "bar"]);
	});

	it("throws on an unexpected opener", () => {
		expect(() => parseQuery(".foo(")).toThrow("unexpected token '('");
	});

	it("throws when quotes do not match, rather than taking the first ]", () => {
		expect(() => parseQuery(`["a']`)).toThrow("unterminated quoted key");
	});
});
