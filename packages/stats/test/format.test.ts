import { describe, expect, it } from "bun:test";
import { formatCostTiered, normalizePremiumRequests } from "../src/format";

describe("formatCostTiered", () => {
	it("uses 4 decimals under a cent", () => {
		expect(formatCostTiered(0.0001)).toBe("$0.0001");
		expect(formatCostTiered(0.0099)).toBe("$0.0099");
		expect(formatCostTiered(0)).toBe("$0.0000");
	});

	it("uses 3 decimals from a cent up to a dollar", () => {
		expect(formatCostTiered(0.01)).toBe("$0.010");
		expect(formatCostTiered(0.5)).toBe("$0.500");
		expect(formatCostTiered(0.999)).toBe("$0.999");
	});

	it("uses 2 decimals from a dollar up", () => {
		expect(formatCostTiered(1)).toBe("$1.00");
		expect(formatCostTiered(12.345)).toBe("$12.35");
		expect(formatCostTiered(1234.5)).toBe("$1234.50");
	});
});

describe("normalizePremiumRequests", () => {
	it("rounds to 2 decimals", () => {
		expect(normalizePremiumRequests(1.005)).toBe(1.01);
		expect(normalizePremiumRequests(0.124)).toBe(0.12);
		expect(normalizePremiumRequests(0.125)).toBe(0.13);
	});

	it("keeps integers and clean values untouched", () => {
		expect(normalizePremiumRequests(3)).toBe(3);
		expect(normalizePremiumRequests(2.5)).toBe(2.5);
		expect(normalizePremiumRequests(0)).toBe(0);
	});

	it("survives float artifacts near the boundary", () => {
		// 1.005 is famously 1.00499999… in IEEE754; EPSILON nudge must fix it.
		expect(normalizePremiumRequests(0.1 + 0.2)).toBe(0.3);
	});
});
