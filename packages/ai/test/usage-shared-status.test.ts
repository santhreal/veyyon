import { describe, expect, it } from "bun:test";
import { USAGE_WARNING_FRACTION, usageStatusFromUsedFraction } from "../src/usage/shared";

describe("usageStatusFromUsedFraction (the single usage-status owner)", () => {
	it("returns unknown when no fraction is reported", () => {
		expect(usageStatusFromUsedFraction(undefined)).toBe("unknown");
	});

	it("returns ok below the warning threshold", () => {
		expect(usageStatusFromUsedFraction(0)).toBe("ok");
		expect(usageStatusFromUsedFraction(0.5)).toBe("ok");
		expect(usageStatusFromUsedFraction(0.8999)).toBe("ok");
	});

	it("flips to warning exactly at the warning threshold", () => {
		expect(USAGE_WARNING_FRACTION).toBe(0.9);
		expect(usageStatusFromUsedFraction(0.9)).toBe("warning");
		expect(usageStatusFromUsedFraction(0.95)).toBe("warning");
		expect(usageStatusFromUsedFraction(0.9999)).toBe("warning");
	});

	it("flips to exhausted exactly at full consumption", () => {
		expect(usageStatusFromUsedFraction(1)).toBe("exhausted");
		expect(usageStatusFromUsedFraction(1.5)).toBe("exhausted");
	});

	it("treats a negative fraction as ok (below warning), never crashing", () => {
		expect(usageStatusFromUsedFraction(-0.1)).toBe("ok");
	});
});
