/**
 * `parseQuery` walks ident / `.` / `[...]` and throws only on an unexpected
 * character at the ident scanner. Anything that IS an ident after a bracket
 * is swallowed as another token.
 *
 * json-query.test.ts already pins missing `]`, empty `[]`, unterminated
 * quotes, and `]` inside a quoted key. Inherited-key walking is
 * apply-query-does-not-walk-inherited-keys.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { applyQuery, parseQuery, pathToQuery } from "@veyyon/coding-agent/internal-urls/json-query";

describe("parseQuery leftover tokens after a complete access", () => {
	it("does not throw on ident junk glued after a finished [index]; it tokenizes it", () => {
		expect(parseQuery(".foo[0]bar")).toEqual(["foo", 0, "bar"]);
	});

	it("skips extra dots between idents rather than throwing", () => {
		expect(parseQuery(".foo..bar")).toEqual(["foo", "bar"]);
	});
});

describe("parseQuery numeric brackets are decimal digit strings only", () => {
	it("treats [00] as number 0, not the string '00'", () => {
		expect(parseQuery("[00]")).toEqual([0]);
		expect(applyQuery(["a", "b"], "[00]")).toBe("a");
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
});

describe("pathToQuery does not invent a leading dot on a bracket-only path", () => {
	it("encodes an apostrophe segment as a bracket key with no leading dot", () => {
		expect(pathToQuery("/a'b")).toBe("['a\\'b']");
	});

	it("leaves an illegal percent sequence undecoded rather than throwing", () => {
		expect(pathToQuery("/%ZZ")).toBe(".%ZZ");
	});
});

describe("applyQuery does not coerce object keys that look like indexes", () => {
	it("does not read object['0'] via [0] — numeric tokens require an array", () => {
		expect(applyQuery({ "0": "nope" }, "[0]")).toBeUndefined();
	});

	it("does not walk from a number primitive", () => {
		expect(applyQuery(4, ".toFixed")).toBeUndefined();
	});
});
