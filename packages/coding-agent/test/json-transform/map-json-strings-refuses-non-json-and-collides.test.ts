/**
 * `mapJsonStrings` is a bounded iterative walk, not JSON.parse.
 *
 * WHY THIS SUITE EXISTS. The walker used to live in the secrets obfuscator
 * and was extracted so provider-boundary / argot-wire / obfuscator share one
 * refuse-don't-degrade loop. `secrets/core-transform-bounds.test.ts` pins
 * depth, nodes, cycles, typed arrays, string-byte caps, and mapped-key
 * collisions through the obfuscator re-export. It does not pin the refusals
 * that only exist on this module: accessors, enumerable symbol keys,
 * ill-formed UTF-16, non-plain class instances, inherited enumerable keys,
 * `undefined` optional fields, NaN/Infinity, and identity preservation when
 * nothing changed.
 *
 * Every throw is a refusal. A walk that skipped what it could not handle
 * would pass the untransformed string through — for the obfuscator that is
 * the credential in the clear.
 */
import { describe, expect, it } from "bun:test";
import {
	JsonTransformError,
	mapJsonStrings,
} from "@veyyon/coding-agent/json-transform";

function identity(s: string): string {
	return s;
}

/** Rewrite payload strings only. Keys must survive, or every assertion about field names is a lie. */
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

	it("refuses a function", () => {
		expect(() => mapJsonStrings((() => 1) as unknown as object, identity)).toThrow(/non-JSON value/i);
	});

	it("refuses NaN and Infinity (JSON.stringify would emit null; this walk must not)", () => {
		expect(() => mapJsonStrings(Number.NaN as unknown as object, identity)).toThrow(/non-JSON value/i);
		expect(() => mapJsonStrings(Number.POSITIVE_INFINITY as unknown as object, identity)).toThrow(/non-JSON value/i);
		expect(() => mapJsonStrings(Number.NEGATIVE_INFINITY as unknown as object, identity)).toThrow(/non-JSON value/i);
	});

	it("refuses a Date / Map / class instance (non-plain object)", () => {
		expect(() => mapJsonStrings(new Date() as unknown as object, identity)).toThrow(/non-plain object/i);
		expect(() => mapJsonStrings(new Map() as unknown as object, identity)).toThrow(/non-plain object/i);
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

	it("does not refuse a non-enumerable symbol key (JSON would drop it too)", () => {
		const value = { visible: "ok" };
		Object.defineProperty(value, Symbol("hidden"), {
			value: "secret",
			enumerable: false,
		});
		expect(mapJsonStrings(value, shoutPayload)).toEqual({ visible: "OK" });
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

	it("refuses ill-formed UTF-16 (unpaired surrogate) in a string value", () => {
		const lone = "lead\uD800";
		expect(() => mapJsonStrings({ s: lone }, identity)).toThrow(/ill-formed UTF-16/i);
	});

	it("refuses ill-formed UTF-16 in an object key", () => {
		const lone = "lead\uD800";
		expect(() => mapJsonStrings({ [lone]: "ok" }, identity)).toThrow(/ill-formed UTF-16/i);
	});

	it("refuses a mapper that returns a non-string", () => {
		expect(() => mapJsonStrings({ s: "x" }, () => 1 as unknown as string)).toThrow(/ill-formed string produced/i);
	});
});

describe("mapJsonStrings walks own enumerable fields only", () => {
	it("refuses a custom-prototype object rather than walking it (fail-closed vs inherited keys)", () => {
		const proto = { leaked: "secret" };
		const value = Object.assign(Object.create(proto), { own: "ok" });
		expect(() => mapJsonStrings(value, shoutPayload)).toThrow(/non-plain object/i);
	});

	it("walks Object.create(null) (null prototype is still a plain record)", () => {
		const value = Object.create(null) as Record<string, string>;
		value.a = "ok";
		const out = mapJsonStrings(value, shoutPayload) as Record<string, string>;
		expect(out.a).toBe("OK");
		expect(Object.getPrototypeOf(out)).toBeNull();
	});

	it("preserves undefined optional fields rather than dropping them the way JSON.stringify does", () => {
		const value: { a: string; b: undefined } = { a: "ok", b: undefined };
		const out = mapJsonStrings(value, shoutPayload);
		expect(out).toEqual({ a: "OK", b: undefined });
		expect("b" in (out as object)).toBe(true);
	});

	it("returns the same object identity when no string changed", () => {
		const value = { a: 1, b: true, c: null, d: [2, false] };
		expect(mapJsonStrings(value, identity)).toBe(value);
	});

	it("returns the same array identity when no element changed", () => {
		const value = [1, true, null, { n: 2 }];
		expect(mapJsonStrings(value, identity)).toBe(value);
	});

	it("copy-on-change: a rewritten nested string does not mutate the input", () => {
		const inner = { s: "ok" };
		const value = { inner };
		const out = mapJsonStrings(value, shoutPayload) as { inner: { s: string } };
		expect(out).not.toBe(value);
		expect(out.inner).not.toBe(inner);
		expect(inner.s).toBe("ok");
		expect(out.inner.s).toBe("OK");
	});

	it("memoizes a shared DAG node so a rewritten object is reused, not cloned twice", () => {
		const shared = { s: "ok" };
		const value = { a: shared, b: shared };
		const out = mapJsonStrings(value, shoutPayload) as { a: { s: string }; b: { s: string } };
		expect(out.a.s).toBe("OK");
		expect(out.a).toBe(out.b);
		expect(shared.s).toBe("ok");
	});

	it("still refuses a cycle even when the back-edge is inside an array", () => {
		const value: { self?: unknown[] } = {};
		value.self = [value];
		expect(() => mapJsonStrings(value, identity)).toThrow(/cyclic/i);
	});
});

describe("mapJsonStrings key-collision is on the mapped keys, not the source keys", () => {
	it("refuses two keys that the mapper folds onto one protected name", () => {
		expect(() => mapJsonStrings({ Token: "a", token: "b" }, s => s.toLowerCase())).toThrow(/same protected key/i);
	});

	it("allows two keys that look similar but map to distinct strings", () => {
		const out = mapJsonStrings({ a: "x", b: "y" }, s => `_${s}`);
		expect(out).toEqual({ _a: "_x", _b: "_y" });
	});
});
