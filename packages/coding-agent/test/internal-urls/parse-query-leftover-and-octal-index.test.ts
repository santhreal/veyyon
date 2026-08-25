/**
 * `parseQuery` walks ident / `.` / `[...]` and throws only on an unexpected
 * character at the ident scanner. Anything that IS an ident after a bracket
 * is swallowed as another token, including leftovers the jq dialect would
 * reject.
 *
 * Existing json-query.test.ts pins missing `]`, empty `[]`, unterminated
 * quotes, and `]` inside a quoted key. It does not pin:
 *
 *   - `[00]` becoming number 0 (leading zeros are still `/^\d+$/`)
 *   - `[0x10]` becoming the STRING "0x10" (not hex 16) because of the `x`
 *   - `.foo[0]bar` concatenating `bar` as a third token instead of throwing
 *   - a trailing comma / pipe / space as an unexpected token
 *   - `pathToQuery("/a'b")` producing `['a\'b']` with NO leading `.`
 *   - `pathToQuery` dropping empty segments so `//` cannot encode a key
 *
 * Inherited-key walking is already pinned in
 * apply-query-does-not-walk-inherited-keys.test.ts; do not clone that.
 */
import { describe, expect, it } from "bun:test";
import { applyQuery, parseQuery, pathToQuery } from "@veyyon/coding-agent/internal-urls/json-query";

describe("parseQuery leftover tokens after a complete access", () => {
	it("does not throw on ident junk glued after a finished [index]; it tokenizes it", () => {
		expect(parseQuery(".foo[0]bar")).toEqual(["foo", 0, "bar"]);
	});

	it("throws on whitespace leftover after a finished access", () => {
		expect(() => parseQuery(".foo[0] bar")).toThrow(/unexpected token/);
	});

	it("throws on a trailing comma", () => {
		expect(() => parseQuery(".foo,")).toThrow(/unexpected token/);
	});

	it("throws on a jq pipe", () => {
		expect(() => parseQuery(".foo|.bar")).toThrow(/unexpected token/);
	});

	it("throws on a recursive-descent token", () => {
		expect(() => parseQuery("..foo")).toThrow(/unexpected token/);
	});

	it("skips extra dots between idents rather than throwing", () => {
		expect(parseQuery(".foo..bar")).toEqual(["foo", "bar"]);
	});

	it("skips a trailing dot rather than throwing", () => {
		expect(parseQuery(".foo.")).toEqual(["foo"]);
	});

	it("throws on a leading bracket-less operator", () => {
		expect(() => parseQuery("(.foo)")).toThrow(/unexpected token/);
	});
});

describe("parseQuery numeric brackets are decimal digit strings only", () => {
	it("treats [00] as number 0, not the string '00'", () => {
		expect(parseQuery("[00]")).toEqual([0]);
		expect(applyQuery(["a", "b"], "[00]")).toBe("a");
	});

	it("treats [01] as number 1, so it is not an octal leftover", () => {
		expect(parseQuery("[01]")).toEqual([1]);
		expect(applyQuery(["a", "b", "c"], "[01]")).toBe("b");
	});

	it("treats [0x10] as the string key '0x10', not index 16", () => {
		expect(parseQuery("[0x10]")).toEqual(["0x10"]);
		expect(applyQuery({ "0x10": "hex-key" }, "[0x10]")).toBe("hex-key");
		expect(applyQuery(new Array(17).fill("slot"), "[0x10]")).toBeUndefined();
	});

	it("treats [-1] as the string key '-1', not the last index", () => {
		expect(parseQuery("[-1]")).toEqual(["-1"]);
		expect(applyQuery(["a", "b"], "[-1]")).toBeUndefined();
		expect(applyQuery({ "-1": "neg" }, "[-1]")).toBe("neg");
	});

	it("treats [1.5] as a string key, not index 1 and not a throw", () => {
		expect(parseQuery("[1.5]")).toEqual(["1.5"]);
	});

	it("does not parse [1e2] as 100", () => {
		expect(parseQuery("[1e2]")).toEqual(["1e2"]);
		expect(applyQuery(new Array(100).fill("n"), "[1e2]")).toBeUndefined();
	});
});

describe("parseQuery quoted keys vs ident charset", () => {
	it("keeps a quoted empty string as a key, which empty [] is forbidden from being", () => {
		expect(parseQuery("['']")).toEqual([""]);
		expect(applyQuery({ "": "empty-key" }, "['']")).toBe("empty-key");
	});

	it("does not treat a unicode ident as an ident (non ASCII fails isIdentChar)", () => {
		expect(() => parseQuery(".名前")).toThrow(/unexpected token/);
	});

	it("accepts unicode only inside a quoted bracket key", () => {
		expect(parseQuery("['名前']")).toEqual(["名前"]);
		expect(applyQuery({ 名前: 7 }, "['名前']")).toBe(7);
	});

	it("stops an ident at a unicode combining mark rather than swallowing it", () => {
		expect(() => parseQuery(".fooé")).toThrow(/unexpected token/);
	});
});

describe("pathToQuery does not invent a leading dot on a bracket-only path", () => {
	it("encodes an apostrophe segment as a bracket key with no leading dot", () => {
		expect(pathToQuery("/a'b")).toBe("['a\\'b']");
		expect(pathToQuery("/a'b").startsWith(".")).toBe(false);
	});

	it("round-trips that apostrophe key through parseQuery and applyQuery", () => {
		const q = pathToQuery("/a'b");
		expect(parseQuery(q)).toEqual(["a'b"]);
		expect(applyQuery({ "a'b": 9 }, q)).toBe(9);
	});

	it("encodes a backslash in a segment so parseQuery can unescape it", () => {
		const q = pathToQuery("/a\\b");
		expect(q).toBe("['a\\\\b']");
		expect(parseQuery(q)).toEqual(["a\\b"]);
	});

	it("cannot preserve an empty-string key because split+filter(Boolean) drops empties", () => {
		expect(pathToQuery("//")).toBe("");
		expect(pathToQuery("/foo//")).toBe(".foo");
	});

	it("does not treat a decoded numeric segment with leading zeros as an ident", () => {
		expect(pathToQuery("/00")).toBe("[00]");
		expect(parseQuery(pathToQuery("/00"))).toEqual([0]);
	});

	it("URL-decodes %27 to an apostrophe before choosing bracket form", () => {
		expect(pathToQuery("/%27")).toBe("['\\'']");
	});

	it("leaves an illegal percent sequence undecoded rather than throwing", () => {
		expect(() => pathToQuery("/%ZZ")).not.toThrow();
		expect(pathToQuery("/%ZZ")).toBe(".%ZZ");
	});
});

describe("applyQuery does not coerce object keys that look like indexes", () => {
	it("does not read object['0'] via [0] — numeric tokens require an array", () => {
		expect(applyQuery({ "0": "nope" }, "[0]")).toBeUndefined();
	});

	it("does read a string token '0' on an object", () => {
		expect(applyQuery({ "0": "yep" }, "['0']")).toBe("yep");
	});

	it("does not walk from a number primitive", () => {
		expect(applyQuery(4, ".toFixed")).toBeUndefined();
	});

	it("does not walk from a string primitive", () => {
		expect(applyQuery("abc", "[0]")).toBeUndefined();
		expect(applyQuery("abc", ".length")).toBeUndefined();
	});
});
