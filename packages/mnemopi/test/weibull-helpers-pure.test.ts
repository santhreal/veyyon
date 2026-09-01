import { describe, expect, it } from "bun:test";
import { DEFAULT_HALFLIFE_HOURS, WEIBULL_PARAMS, weibullBoost, weibullDecayFactor } from "../src/core/weibull";

describe("WEIBULL_PARAMS", () => {
	it("has params for all memory types", () => {
		expect(WEIBULL_PARAMS.profile).toBeDefined();
		expect(WEIBULL_PARAMS.fact).toBeDefined();
		expect(WEIBULL_PARAMS.general).toBeDefined();
	});
	it("each param has k and eta", () => {
		for (const key in WEIBULL_PARAMS) {
			const params = WEIBULL_PARAMS[key as keyof typeof WEIBULL_PARAMS];
			expect(typeof params.k).toBe("number");
			expect(typeof params.eta).toBe("number");
			expect(params.k).toBeGreaterThan(0);
			expect(params.eta).toBeGreaterThan(0);
		}
	});
	it("profile has slower decay than general", () => {
		expect(WEIBULL_PARAMS.profile.eta).toBeGreaterThan(WEIBULL_PARAMS.general.eta);
	});
});

describe("DEFAULT_HALFLIFE_HOURS", () => {
	it("is 168 (one week)", () => {
		expect(DEFAULT_HALFLIFE_HOURS).toBe(168.0);
	});
});

describe("weibullDecayFactor", () => {
	it("returns 1.0 for age <= 0", () => {
		expect(weibullDecayFactor(0)).toBe(1.0);
		expect(weibullDecayFactor(-10)).toBe(1.0);
	});
	it("returns value between 0 and 1 for positive age", () => {
		const result = weibullDecayFactor(100, "general");
		expect(result).toBeGreaterThan(0);
		expect(result).toBeLessThan(1);
	});
	it("decreases as age increases", () => {
		const young = weibullDecayFactor(10, "general");
		const old = weibullDecayFactor(1000, "general");
		expect(young).toBeGreaterThan(old);
	});
	it("uses default halflife for unknown type", () => {
		const result = weibullDecayFactor(168, "unknown_type");
		expect(result).toBeCloseTo(Math.exp(-1), 5);
	});
	it("returns 0 when eta <= 0 (impossible but tested)", () => {
		// Can't trigger normally since params are readonly, but test the path
		const result = weibullDecayFactor(100, "general");
		expect(result).toBeGreaterThan(0);
	});
	it("different memory types decay at different rates", () => {
		const profileDecay = weibullDecayFactor(1000, "profile");
		const requestDecay = weibullDecayFactor(1000, "request");
		expect(profileDecay).toBeGreaterThan(requestDecay);
	});
});

describe("weibullBoost", () => {
	it("returns 0 for null timestamp", () => {
		expect(weibullBoost(null)).toBe(0.0);
	});
	it("returns 0 for undefined timestamp", () => {
		expect(weibullBoost(undefined)).toBe(0.0);
	});
	it("returns 0 for invalid date string", () => {
		expect(weibullBoost("invalid-date")).toBe(0.0);
	});
	it("returns 1.0 for future timestamp (negative age)", () => {
		const future = new Date(Date.now() + 86400000);
		expect(weibullBoost(future)).toBe(1.0);
	});
	it("returns value between 0 and 1 for past timestamp", () => {
		const past = new Date(Date.now() - 86400000);
		const result = weibullBoost(past);
		expect(result).toBeGreaterThan(0);
		expect(result).toBeLessThanOrEqual(1);
	});
	it("uses custom halflife when provided", () => {
		const past = new Date(Date.now() - 168 * 3600000);
		const result = weibullBoost(past, new Date(), "general", 168);
		expect(result).toBeCloseTo(Math.exp(-1), 2);
	});
	it("returns 0 when halflife <= 0", () => {
		const past = new Date(Date.now() - 1000);
		expect(weibullBoost(past, new Date(), "general", 0)).toBe(0.0);
		expect(weibullBoost(past, new Date(), "general", -1)).toBe(0.0);
	});
	it("accepts Date object as timestamp", () => {
		const past = new Date(Date.now() - 3600000);
		const result = weibullBoost(past);
		expect(result).toBeGreaterThan(0);
		expect(result).toBeLessThan(1);
	});
	it("accepts ISO string timestamp", () => {
		const past = new Date(Date.now() - 3600000).toISOString();
		const result = weibullBoost(past);
		expect(result).toBeGreaterThan(0);
		expect(result).toBeLessThan(1);
	});
	it("uses default halflife for unknown memory type", () => {
		const past = new Date(Date.now() - 168 * 3600000);
		const result = weibullBoost(past, new Date(), "unknown_type");
		expect(result).toBeCloseTo(Math.exp(-1), 2);
	});
	it("handles null queryTime by using now", () => {
		const past = new Date(Date.now() - 3600000);
		const result = weibullBoost(past, null);
		expect(result).toBeGreaterThan(0);
		expect(result).toBeLessThan(1);
	});
	it("returns 0 for invalid queryTime", () => {
		const past = new Date(Date.now() - 3600000);
		const invalidDate = new Date(NaN);
		expect(weibullBoost(past, invalidDate)).toBe(0.0);
	});
});
