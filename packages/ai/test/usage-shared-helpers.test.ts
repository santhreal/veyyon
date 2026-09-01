import { describe, expect, it } from "bun:test";
import { USAGE_WARNING_FRACTION, usageStatusFromUsedFraction } from "../src/usage/shared";

describe("USAGE_WARNING_FRACTION", () => {
	it("is 0.9", () => {
		expect(USAGE_WARNING_FRACTION).toBe(0.9);
	});
});

describe("usageStatusFromUsedFraction", () => {
	it("returns 'unknown' for undefined", () => {
		expect(usageStatusFromUsedFraction(undefined)).toBe("unknown");
	});
	it("returns 'ok' for 0", () => {
		expect(usageStatusFromUsedFraction(0)).toBe("ok");
	});
	it("returns 'ok' for 0.5", () => {
		expect(usageStatusFromUsedFraction(0.5)).toBe("ok");
	});
	it("returns 'ok' for 0.89", () => {
		expect(usageStatusFromUsedFraction(0.89)).toBe("ok");
	});
	it("returns 'warning' at 0.9 threshold", () => {
		expect(usageStatusFromUsedFraction(0.9)).toBe("warning");
	});
	it("returns 'warning' for 0.95", () => {
		expect(usageStatusFromUsedFraction(0.95)).toBe("warning");
	});
	it("returns 'warning' for 0.99", () => {
		expect(usageStatusFromUsedFraction(0.99)).toBe("warning");
	});
	it("returns 'exhausted' at 1.0", () => {
		expect(usageStatusFromUsedFraction(1.0)).toBe("exhausted");
	});
	it("returns 'exhausted' above 1.0", () => {
		expect(usageStatusFromUsedFraction(1.5)).toBe("exhausted");
	});
	it("returns 'exhausted' for exactly 1", () => {
		expect(usageStatusFromUsedFraction(1)).toBe("exhausted");
	});
	it("returns 'ok' for negative fraction", () => {
		expect(usageStatusFromUsedFraction(-0.1)).toBe("ok");
	});
});
