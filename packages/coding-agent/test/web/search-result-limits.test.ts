import { describe, expect, it } from "bun:test";
import {
	applyResultLimit,
	clampNumResults,
	dateToAgeSeconds,
	sanitizeResultLimit,
} from "@veyyon/coding-agent/web/search/utils";

/**
 * These four helpers own the "how many web-search results survive" rules across every provider.
 * They had no direct test. The number they compute is handed straight to a search API as count/limit
 * and to Array.slice, so an off-by-one or sign slip silently returns the wrong results (the doc for
 * sanitizeResultLimit even records a prior bug where a negative limit dropped results from the END).
 * These pin the floor/clamp bounds, the "no default cap means absent stays absent" rule, and that
 * applyResultLimit returns the SAME reference when it does not cap (no needless copy).
 */

describe("dateToAgeSeconds", () => {
	it("returns undefined for empty, null, undefined, or unparseable dates", () => {
		expect(dateToAgeSeconds(null)).toBeUndefined();
		expect(dateToAgeSeconds(undefined)).toBeUndefined();
		expect(dateToAgeSeconds("")).toBeUndefined();
		expect(dateToAgeSeconds("not-a-date")).toBeUndefined();
	});

	it("returns the whole-second age of a past ISO date and a negative age for a future one", () => {
		const iso = "2020-01-01T00:00:00.000Z";
		const expected = Math.floor((Date.now() - Date.parse(iso)) / 1000);
		// Two Date.now() reads a few microseconds apart can straddle a second boundary; allow 1s slack.
		expect(Math.abs((dateToAgeSeconds(iso) as number) - expected)).toBeLessThanOrEqual(1);
		expect(dateToAgeSeconds(new Date(Date.now() + 100_000).toISOString()) as number).toBeLessThan(0);
	});
});

describe("clampNumResults", () => {
	it("returns the default for an absent, zero, or NaN value", () => {
		expect(clampNumResults(undefined, 3, 10)).toBe(3);
		expect(clampNumResults(0, 3, 10)).toBe(3);
		expect(clampNumResults(Number.NaN, 3, 10)).toBe(3);
	});

	it("clamps into [1, maxVal] and floors a fractional count", () => {
		expect(clampNumResults(5.7, 3, 10)).toBe(5);
		expect(clampNumResults(100, 3, 10)).toBe(10);
		expect(clampNumResults(0.5, 3, 10)).toBe(1);
		expect(clampNumResults(-3, 3, 10)).toBe(1);
	});
});

describe("sanitizeResultLimit", () => {
	it("treats anything not a finite number >= 1 as no explicit limit (undefined)", () => {
		expect(sanitizeResultLimit(undefined)).toBeUndefined();
		expect(sanitizeResultLimit(Number.NaN)).toBeUndefined();
		expect(sanitizeResultLimit(Number.POSITIVE_INFINITY)).toBeUndefined();
		expect(sanitizeResultLimit(0)).toBeUndefined();
		expect(sanitizeResultLimit(0.5)).toBeUndefined();
		expect(sanitizeResultLimit(-3)).toBeUndefined();
	});

	it("floors a valid positive limit to a whole count", () => {
		expect(sanitizeResultLimit(3.9)).toBe(3);
		expect(sanitizeResultLimit(5)).toBe(5);
	});
});

describe("applyResultLimit", () => {
	const sources = [1, 2, 3, 4, 5];

	it("returns the same list reference when there is no cap or the list is within it", () => {
		expect(applyResultLimit(sources, undefined)).toBe(sources);
		expect(applyResultLimit(sources, 10)).toBe(sources);
		expect(applyResultLimit(sources, 5)).toBe(sources);
	});

	it("slices from the front when the list exceeds a positive limit", () => {
		const capped = applyResultLimit(sources, 2);
		expect(capped).toEqual([1, 2]);
		expect(capped).not.toBe(sources);
	});

	it("returns everything for a negative limit instead of dropping from the end", () => {
		// Regression guard: a negative limit once reached slice(0, negative) and dropped the tail.
		expect(applyResultLimit(sources, -2)).toBe(sources);
	});
});
