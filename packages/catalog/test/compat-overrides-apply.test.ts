/**
 * Contract tests for `applyCompatOverrides`.
 *
 * The function assigns defined override values onto a freshly-built resolved
 * compat record, in place, honoring exactly one rule: a key is applied only when
 * the record ALREADY declares it. Its documented promise is "keys the record
 * doesn't declare are ignored." These tests pin that promise against the two
 * ways it can quietly break:
 *
 *  - prototype-key leakage: `key in compat` (the old guard) is true for every
 *    `Object.prototype` member, so an override named `toString`/`constructor`/
 *    `valueOf`/`hasOwnProperty` used to pass the guard and overwrite an inherited
 *    method the record never declared — the opposite of the contract, and a way
 *    to corrupt a shared record from loosely-typed config;
 *  - prototype-source leakage: an override object carrying inherited enumerable
 *    keys must not have those keys applied either.
 *
 * They also lock the intended behavior: declared keys are overwritten, undefined
 * override values are skipped (so a sparse override never clobbers a resolved
 * default with `undefined`), and undeclared-but-own override keys are ignored.
 */
import { describe, expect, it } from "bun:test";
import { applyCompatOverrides } from "@veyyon/catalog/compat/apply";

describe("applyCompatOverrides", () => {
	it("overwrites a declared key with a defined override value", () => {
		const compat = { supportsSamplingParams: true, officialEndpoint: false };
		applyCompatOverrides(compat, { supportsSamplingParams: false });
		expect(compat.supportsSamplingParams).toBe(false);
		expect(compat.officialEndpoint).toBe(false);
	});

	it("skips an override whose value is undefined, preserving the resolved default", () => {
		// A sparse override object (config that omits a field but still enumerates
		// it as `undefined`) must never overwrite a real resolved value with
		// `undefined`. Detection wrote `true`; the undefined override leaves it.
		const compat = { supportsLongCacheRetention: true };
		applyCompatOverrides(compat, { supportsLongCacheRetention: undefined });
		expect(compat.supportsLongCacheRetention).toBe(true);
	});

	it("ignores an own override key the record does not declare", () => {
		// "Keys the record doesn't declare are ignored" — junk config fields must
		// not appear on the record.
		const compat: Record<string, unknown> = { officialEndpoint: false };
		applyCompatOverrides(compat, { totallyUnknownField: 42 });
		expect(Object.hasOwn(compat, "totallyUnknownField")).toBe(false);
		expect(compat.officialEndpoint).toBe(false);
	});

	it("does not overwrite an inherited method for an override named after an Object.prototype key", () => {
		// Regression: `key in compat` was true for every Object.prototype member,
		// so `toString`/`valueOf`/`hasOwnProperty`/`constructor` overrides — none of
		// which the record OWNS — used to pass the guard and shadow the inherited
		// method with arbitrary config data. `Object.hasOwn` rejects them: the
		// record declares none of these as own properties, so each is ignored and
		// the prototype method stays intact and callable.
		const compat: Record<string, unknown> = { officialEndpoint: true };
		applyCompatOverrides(compat, {
			toString: "corrupted",
			valueOf: 0,
			constructor: null,
			hasOwnProperty: 1,
		} as unknown as object);

		expect(Object.hasOwn(compat, "toString")).toBe(false);
		expect(Object.hasOwn(compat, "valueOf")).toBe(false);
		expect(Object.hasOwn(compat, "constructor")).toBe(false);
		expect(Object.hasOwn(compat, "hasOwnProperty")).toBe(false);
		// The inherited machinery is untouched: toString is still the function, and
		// the own-key check the function itself relies on still works.
		expect(typeof compat.toString).toBe("function");
		expect(Object.prototype.hasOwnProperty.call(compat, "officialEndpoint")).toBe(true);
		expect(compat.officialEndpoint).toBe(true);
	});

	it("applies a declared key even when its name collides with a prototype member", () => {
		// The guard keys on OWNERSHIP, not the name: if the record genuinely
		// declares a field that happens to share a prototype-member name, a matching
		// override still applies. This proves the fix rejects prototype keys by
		// ownership, not by blacklisting names.
		const compat: Record<string, unknown> = { toString: "declared-own-value" };
		applyCompatOverrides(compat, { toString: "override-value" } as unknown as object);
		expect(compat.toString).toBe("override-value");
	});

	it("does not apply inherited enumerable keys from the override object", () => {
		// The override source is iterated by own keys only. A key living on the
		// override's prototype must not be copied onto the record even if the record
		// declares it.
		const base = { officialEndpoint: true };
		const overrides = Object.create({ officialEndpoint: false }) as object;
		const compat = { officialEndpoint: true };
		applyCompatOverrides(compat, overrides);
		expect(compat.officialEndpoint).toBe(true);
		// Sanity: the inherited value really was visible via `in`, proving the guard
		// mattered.
		expect("officialEndpoint" in overrides).toBe(true);
		expect(Object.hasOwn(overrides, "officialEndpoint")).toBe(false);
		expect(base.officialEndpoint).toBe(true);
	});

	it("is a no-op when overrides is undefined", () => {
		const compat = { supportsSamplingParams: true };
		applyCompatOverrides(compat, undefined);
		expect(compat.supportsSamplingParams).toBe(true);
	});
});
