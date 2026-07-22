import { describe, expect, it } from "bun:test";
import { formatPhaseDisplayName, phaseRomanNumeral } from "@veyyon/coding-agent/tools/todo";

/**
 * Roman numeral phase labels for 1..20 and display name format.
 */

describe("phaseRomanNumeral property", () => {
	const expected: Record<number, string> = {
		1: "I",
		2: "II",
		3: "III",
		4: "IV",
		5: "V",
		6: "VI",
		7: "VII",
		8: "VIII",
		9: "IX",
		10: "X",
		11: "XI",
		14: "XIV",
		15: "XV",
		19: "XIX",
		20: "XX",
	};

	it("matches standard roman for known values", () => {
		for (const [n, roman] of Object.entries(expected)) {
			expect(phaseRomanNumeral(Number(n))).toBe(roman);
		}
	});

	it("non-positive returns empty string", () => {
		expect(phaseRomanNumeral(0)).toBe("");
		expect(phaseRomanNumeral(-1)).toBe("");
	});

	it("formatPhaseDisplayName is Roman. Name", () => {
		expect(formatPhaseDisplayName("Build", 1)).toBe("I. Build");
		expect(formatPhaseDisplayName("Ship", 10)).toBe("X. Ship");
		for (let i = 1; i <= 12; i++) {
			const out = formatPhaseDisplayName("P", i);
			expect(out.startsWith(phaseRomanNumeral(i) + ". ")).toBe(true);
			expect(out.endsWith("P")).toBe(true);
		}
	});
});
