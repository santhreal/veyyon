import { describe, expect, it } from "bun:test";
import { parseJsonWithRepair, parseStreamingJson } from "@veyyon/utils/json-parse";

/**
 * The relaxed / streaming JSON parser (RelaxedJson) builds objects one parsed key
 * at a time. It runs whenever native `JSON.parse` throws: a malformed or truncated
 * buffer, e.g. a mid-stream tool-call argument object. A bare `out[key] = value`
 * for a literal `__proto__` key would diverge from native `JSON.parse`: an object
 * value would REPLACE the parsed object's prototype (the key vanishing and its
 * fields leaking in as phantom inherited members) and a string value would be
 * dropped. `constructor`/`prototype` keys would shadow built-ins.
 *
 * Native `JSON.parse` instead stores `__proto__` as a plain own data property.
 * These tests pin the relaxed parser to that exact behavior so a `__proto__` key
 * in malformed/streamed model output can never corrupt the parsed arguments.
 */

/** Assert `obj` carries `expected` under a literal own `key` with prototype intact. */
function expectSafeOwnKey(obj: Record<string, unknown>, key: string, expected: unknown): void {
	expect(Object.getPrototypeOf(obj)).toBe(Object.prototype);
	expect(Object.hasOwn(obj, key)).toBe(true);
	expect(Object.getOwnPropertyDescriptor(obj, key)?.value).toEqual(expected);
}

describe("RelaxedJson __proto__ key handling (parseJsonWithRepair on malformed input)", () => {
	it("stores a __proto__ object value as an own property when a trailing comma forces the relaxed path", () => {
		// The trailing comma makes native JSON.parse throw, routing to RelaxedJson.
		const parsed = parseJsonWithRepair<Record<string, unknown>>('{"__proto__": {"polluted": true},}');
		expectSafeOwnKey(parsed, "__proto__", { polluted: true });
		expect((parsed as { polluted?: unknown }).polluted).toBeUndefined();
	});

	it("recovers a single-quoted __proto__ string key (invalid JSON) as an own property", () => {
		const parsed = parseJsonWithRepair<Record<string, unknown>>("{'__proto__': 'evil', 'path': 'a.ts'}");
		expectSafeOwnKey(parsed, "__proto__", "evil");
		expect(parsed.path).toBe("a.ts");
		expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
	});

	it("stores literal constructor and prototype keys as own properties on the relaxed path", () => {
		const parsed = parseJsonWithRepair<Record<string, unknown>>('{"constructor": 1, "prototype": 2,}');
		expectSafeOwnKey(parsed, "constructor", 1);
		expectSafeOwnKey(parsed, "prototype", 2);
	});

	it("keeps a nested object's __proto__ key as an own property without prototype mutation", () => {
		const parsed = parseJsonWithRepair<{ outer: Record<string, unknown> }>('{"outer": {"__proto__": "x"},}');
		expectSafeOwnKey(parsed.outer, "__proto__", "x");
	});
});

describe("streaming JSON __proto__ key handling (parseStreamingJson on truncated input)", () => {
	it("assembles a truncated __proto__ object value as an own property, not a prototype mutation", () => {
		// Truncated mid-object: native JSON.parse throws, RelaxedJson auto-closes.
		const parsed = parseStreamingJson<Record<string, unknown>>('{"__proto__": {"a": 1');
		expectSafeOwnKey(parsed, "__proto__", { a: 1 });
		expect((parsed as { a?: unknown }).a).toBeUndefined();
	});

	it("keeps a truncated __proto__ string value as an own property", () => {
		const parsed = parseStreamingJson<Record<string, unknown>>('{"path": "a.ts", "__proto__": "ev');
		expect(parsed.path).toBe("a.ts");
		expectSafeOwnKey(parsed, "__proto__", "ev");
	});
});

describe("native fast path stays consistent (control)", () => {
	it("parseJsonWithRepair on well-formed input already stores __proto__ safely via JSON.parse", () => {
		// This never reaches RelaxedJson; it proves both paths agree on the shape.
		const parsed = parseJsonWithRepair<Record<string, unknown>>('{"__proto__": {"a": 1}}');
		expectSafeOwnKey(parsed, "__proto__", { a: 1 });
	});
});
