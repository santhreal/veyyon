import { describe, expect, it } from "bun:test";
import { formatCostTiered, normalizePremiumRequests } from "../src/format";

/**
 * Terminal cost/premium formatters: tier boundaries and negative/zero inputs
 * must stay deterministic so status-line and CLI never flip formats mid-run.
 */

describe("stats format adversarial", () => {
	it("formatCostTiered uses 4 decimals below 0.01, 3 below 1, else 2", () => {
		expect(formatCostTiered(0)).toBe("$0.0000");
		expect(formatCostTiered(0.00123)).toBe("$0.0012");
		expect(formatCostTiered(0.00999)).toBe("$0.0100"); // rounds into 0.01 boundary
		expect(formatCostTiered(0.01)).toBe("$0.010");
		expect(formatCostTiered(0.5)).toBe("$0.500");
		expect(formatCostTiered(1)).toBe("$1.00");
		expect(formatCostTiered(12.345)).toBe("$12.35");
	});

	it("normalizePremiumRequests rounds half-up style to 2 decimals", () => {
		expect(normalizePremiumRequests(0)).toBe(0);
		expect(normalizePremiumRequests(1.234)).toBe(1.23);
		expect(normalizePremiumRequests(1.235)).toBe(1.24);
		expect(normalizePremiumRequests(10)).toBe(10);
	});

	it("formatCostTiered on negative values keeps the sign prefix after $", () => {
		// Document actual behavior: toFixed keeps the minus.
		const out = formatCostTiered(-0.5);
		expect(out.startsWith("$")).toBe(true);
		expect(out).toContain("-");
	});
});
