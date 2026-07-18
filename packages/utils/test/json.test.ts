import { describe, expect, it } from "bun:test";
import { stringifyJson, tryParseJson } from "../src/json";

describe("tryParseJson", () => {
	it("parses valid JSON to the exact value", () => {
		expect(tryParseJson<{ a: number; b: (boolean | null)[] }>('{"a":1,"b":[true,null]}')).toEqual({
			a: 1,
			b: [true, null],
		});
		expect(tryParseJson<string>('"plain string"')).toBe("plain string");
		expect(tryParseJson<number>("42")).toBe(42);
	});

	it("returns null for malformed input instead of throwing", () => {
		expect(tryParseJson("{a:1}")).toBeNull();
		expect(tryParseJson("")).toBeNull();
		expect(tryParseJson("[1,")).toBeNull();
	});

	it("distinguishes a parsed null literal only by identity of use", () => {
		// Documented sharp edge: "null" parses to null, indistinguishable from failure.
		expect(tryParseJson("null")).toBeNull();
	});
});

describe("stringifyJson", () => {
	it("matches JSON.stringify for plain values, including the space argument", () => {
		const value = { a: 1, nested: { b: ["x"] } };
		expect(stringifyJson(value)).toBe(JSON.stringify(value));
		expect(stringifyJson(value, 2)).toBe(JSON.stringify(value, null, 2));
	});

	it("serializes bigints as decimal strings where JSON.stringify throws", () => {
		expect(() => JSON.stringify({ n: 123n })).toThrow();
		expect(stringifyJson({ n: 123n })).toBe('{"n":"123"}');
		expect(stringifyJson({ big: 9007199254740993n })).toBe('{"big":"9007199254740993"}');
	});

	it("returns undefined for undefined input, like JSON.stringify", () => {
		expect(stringifyJson(undefined)).toBeUndefined();
	});
});
