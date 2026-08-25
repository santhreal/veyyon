/**
 * `mapJsonStrings` is a bounded iterative walk, not JSON.parse.
 *
 * WHY THIS SUITE EXISTS. `secrets/core-transform-bounds.test.ts` pins
 * depth, nodes, cycles, typed arrays, string-byte caps, and mapped-key
 * collisions through the obfuscator re-export.
 * `architecture/the-json-walk-is-not-a-secrets-module.test.ts` already
 * pins ill-formed UTF-16 and identity-when-unchanged. Remaining refusals
 * that only exist on this module: bigint/NaN/Infinity, accessors,
 * enumerable symbol keys, non-plain class instances, inherited keys,
 * `undefined` optional fields, and case-fold key collision.
 */
import { describe, expect, it } from "bun:test";
import { JsonTransformError, mapJsonStrings } from "@veyyon/coding-agent/json-transform";

function identity(s: string): string {
	return s;
}

function shoutPayload(s: string): string {
	return s === "ok" || s === "secret" || s.startsWith("ok-") ? s.toUpperCase() : s;
}

describe("mapJsonStrings refuses values JSON cannot carry", () => {
	it("refuses bigint", () => {
		expect(() => mapJsonStrings(1n as unknown as object, identity)).toThrow(JsonTransformError);
		try {
			mapJsonStrings(1n as unknown as object, identity);
		} catch (err) {
			expect(err).toBeInstanceOf(JsonTransformError);
			expect((err as JsonTransformError).code).toBe("non-json-value");
		}
	});

	it("refuses NaN and Infinity (JSON.stringify would emit null; this walk must not)", () => {
		expect(() => mapJsonStrings(Number.NaN as unknown as object, identity)).toThrow(/non-JSON value/i);
		expect(() => mapJsonStrings(Number.POSITIVE_INFINITY as unknown as object, identity)).toThrow(/non-JSON value/i);
	});

	it("refuses a Date / Map / class instance (non-plain object)", () => {
		expect(() => mapJsonStrings(new Date() as unknown as object, identity)).toThrow(/non-plain object/i);
		class Box {
			v = "secret";
		}
		expect(() => mapJsonStrings(new Box() as unknown as object, identity)).toThrow(/non-plain object/i);
	});

	it("refuses an enumerable symbol key rather than silently dropping it", () => {
		const value = { visible: "ok" };
		Object.defineProperty(value, Symbol("hidden"), {
			value: "secret",
			enumerable: true,
		});
		expect(() => mapJsonStrings(value, shoutPayload)).toThrow(/symbol key/i);
	});

	it("refuses an accessor property rather than invoking the getter (getters can leak)", () => {
		const value = {};
		Object.defineProperty(value, "token", {
			enumerable: true,
			get: () => "sk-live",
			set: () => undefined,
		});
		expect(() => mapJsonStrings(value, shoutPayload)).toThrow(/accessor/i);
	});

	it("refuses an array hole that is actually an accessor index", () => {
		const value: unknown[] = ["ok"];
		Object.defineProperty(value, "1", {
			enumerable: true,
			get: () => "sk-live",
			set: () => undefined,
		});
		expect(() => mapJsonStrings(value, shoutPayload)).toThrow(/accessor/i);
	});
});

describe("mapJsonStrings walks own enumerable fields only", () => {
	it("refuses a custom-prototype object rather than walking it (fail-closed vs inherited keys)", () => {
		const proto = { leaked: "secret" };
		const value = Object.assign(Object.create(proto), { own: "ok" });
		expect(() => mapJsonStrings(value, shoutPayload)).toThrow(/non-plain object/i);
	});

	it("preserves undefined optional fields rather than dropping them the way JSON.stringify does", () => {
		const value: { a: string; b: undefined } = { a: "ok", b: undefined };
		const out = mapJsonStrings(value, shoutPayload);
		expect(out).toEqual({ a: "OK", b: undefined });
		expect("b" in (out as object)).toBe(true);
	});
});

describe("mapJsonStrings key-collision is on the mapped keys, not the source keys", () => {
	it("refuses two keys that the mapper folds onto one protected name", () => {
		expect(() => mapJsonStrings({ Token: "a", token: "b" }, s => s.toLowerCase())).toThrow(/same protected key/i);
	});
});
