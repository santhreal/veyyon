import { describe, expect, it } from "bun:test";
import { normalizeProviderMaxInFlightRequests } from "@veyyon/coding-agent/config/settings";

/**
 * normalizeProviderMaxInFlightRequests sanitizes the persisted per-provider concurrency
 * cap before the scheduler uses it. It had no test, yet a bad value here would either
 * throttle a provider to a nonsensical limit or crash the scheduler. Contract:
 *   - a non-record (null, string, array) yields an empty map;
 *   - each entry is kept only when the raw limit is a finite number > 0; a non-number,
 *     non-finite, zero, or negative value is dropped;
 *   - a kept value is floored, then clamped up to at least 1, so a positive fraction
 *     below 1 (e.g. 0.5) becomes 1 rather than 0.
 */

describe("normalizeProviderMaxInFlightRequests", () => {
	it("returns an empty map for non-record input, including arrays", () => {
		expect(normalizeProviderMaxInFlightRequests(null)).toEqual({});
		expect(normalizeProviderMaxInFlightRequests("x")).toEqual({});
		expect(normalizeProviderMaxInFlightRequests([1, 2])).toEqual({});
		expect(normalizeProviderMaxInFlightRequests({})).toEqual({});
	});

	it("keeps finite positive limits, floors fractions, and clamps below-one up to one", () => {
		expect(
			normalizeProviderMaxInFlightRequests({
				openai: 4,
				anthropic: 2.9,
				frac: 0.5,
			}),
		).toEqual({ openai: 4, anthropic: 2, frac: 1 });
	});

	it("drops non-number, non-finite, zero, and negative limits", () => {
		expect(
			normalizeProviderMaxInFlightRequests({
				str: "5",
				inf: Number.POSITIVE_INFINITY,
				nan: Number.NaN,
				zero: 0,
				neg: -3,
			}),
		).toEqual({});
	});
});
