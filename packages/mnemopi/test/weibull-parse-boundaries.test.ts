import { describe, expect, it } from "bun:test";
import { DEFAULT_HALFLIFE_HOURS, WEIBULL_PARAMS, weibullBoost, weibullDecayFactor } from "../src/core/weibull";

describe("weibullBoost timestamp parsing boundaries", () => {
	it("accepts Date instances and rejects invalid ones", () => {
		const now = new Date("2026-06-01T00:00:00Z");
		expect(weibullBoost(now, now)).toBeCloseTo(1.0, 10);
		expect(weibullBoost(new Date("garbage"), now)).toBe(0.0);
	});

	it("falls back to regex parsing when Date() rejects a zoned-bracket suffix", () => {
		// new Date() fails on the [Zone] suffix; the 26-char truncation + regex path
		// constructs a LOCAL time, so compare against the same local construction.
		const local = new Date(2026, 0, 2, 3, 4, 5, 123);
		expect(weibullBoost("2026-01-02T03:04:05.123456+05:30[Asia/Kolkata]", local)).toBeCloseTo(1.0, 10);
	});

	it("returns 0 when the query time itself is invalid", () => {
		expect(weibullBoost("2026-01-01T00:00:00Z", new Date("garbage"))).toBe(0.0);
	});
});

describe("weibullBoost halflife override", () => {
	const query = new Date("2026-06-02T00:00:00Z");
	const dayOld = "2026-06-01T00:00:00Z";

	it("uses exponential decay with the explicit halflife instead of Weibull params", () => {
		expect(weibullBoost(dayOld, query, "profile", 24)).toBeCloseTo(Math.exp(-1), 10);
	});

	it("returns 0 for a non-positive halflife", () => {
		expect(weibullBoost(dayOld, query, "general", 0)).toBe(0.0);
		expect(weibullBoost(dayOld, query, "general", -5)).toBe(0.0);
	});

	it("uses DEFAULT_HALFLIFE_HOURS exponential decay for unknown memory types", () => {
		expect(weibullBoost(dayOld, query, "no-such-type")).toBeCloseTo(Math.exp(-24 / DEFAULT_HALFLIFE_HOURS), 10);
	});
});

describe("weibullDecayFactor boundaries", () => {
	it("is exactly 1 at zero or negative age", () => {
		expect(weibullDecayFactor(0, "profile")).toBe(1.0);
		expect(weibullDecayFactor(-10, "request")).toBe(1.0);
	});

	it("matches the exact Weibull formula for a typed entry", () => {
		const { k, eta } = WEIBULL_PARAMS.decision;
		expect(weibullDecayFactor(eta, "decision")).toBeCloseTo(Math.exp(-((eta / eta) ** k)), 10);
		expect(weibullDecayFactor(720, "fact")).toBeCloseTo(Math.exp(-((720 / 720.0) ** 0.8)), 10);
	});

	it("falls back to default exponential decay for unknown types", () => {
		expect(weibullDecayFactor(168, "no-such-type")).toBeCloseTo(Math.exp(-1), 10);
	});
});
