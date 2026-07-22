import { describe, expect, it } from "bun:test";
import { validateProviderMaxInFlightRequests } from "@veyyon/coding-agent/config/settings";

/**
 * validateProviderMaxInFlightRequests normalizes the user-supplied per-provider concurrency map from
 * settings before it gates real request scheduling. It had no direct test. It must fail CLOSED on a
 * bad limit (throw, naming every offending provider) rather than silently dropping it, coerce a
 * fractional-but-positive limit down to a whole request while never going below 1, and treat any
 * non-object input as "no overrides" ({}). A regression that swallowed a bad value would let a typo
 * silently disable a provider's concurrency cap; one that mis-floored would run more requests than
 * configured. These pin each rule.
 */
describe("validateProviderMaxInFlightRequests", () => {
	it("returns an empty map for any non-object input", () => {
		expect(validateProviderMaxInFlightRequests(null)).toEqual({});
		expect(validateProviderMaxInFlightRequests(undefined)).toEqual({});
		expect(validateProviderMaxInFlightRequests(42)).toEqual({});
		expect(validateProviderMaxInFlightRequests("openai")).toEqual({});
		// An array is not a plain record and carries no provider keys.
		expect(validateProviderMaxInFlightRequests([1, 2])).toEqual({});
	});

	it("keeps positive integer limits as-is", () => {
		expect(validateProviderMaxInFlightRequests({ openai: 3, anthropic: 8 })).toEqual({ openai: 3, anthropic: 8 });
	});

	it("floors a fractional limit toward zero", () => {
		expect(validateProviderMaxInFlightRequests({ openai: 2.9 })).toEqual({ openai: 2 });
	});

	it("clamps a positive sub-one limit up to 1 so a provider is never fully starved", () => {
		expect(validateProviderMaxInFlightRequests({ openai: 0.4 })).toEqual({ openai: 1 });
	});

	it("throws and names every provider whose limit is not a positive finite number", () => {
		expect(() => validateProviderMaxInFlightRequests({ openai: 0, x: -1, y: "z" })).toThrow(
			"Provider request limits must be positive numbers: openai, x, y",
		);
	});

	it("rejects a non-finite limit rather than passing Infinity through", () => {
		expect(() => validateProviderMaxInFlightRequests({ a: Number.POSITIVE_INFINITY })).toThrow(
			"Provider request limits must be positive numbers: a",
		);
		expect(() => validateProviderMaxInFlightRequests({ a: Number.NaN })).toThrow(
			"Provider request limits must be positive numbers: a",
		);
	});
});
