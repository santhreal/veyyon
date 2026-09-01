import { describe, expect, it } from "bun:test";
import { canonicalizeEfforts, Effort, isEffort, THINKING_EFFORTS } from "../src/effort";

describe("Effort enum", () => {
	it("Minimal is 'minimal'", () => {
		expect(Effort.Minimal).toBe("minimal" as typeof Effort.Minimal);
	});
	it("Low is 'low'", () => {
		expect(Effort.Low).toBe("low" as typeof Effort.Low);
	});
	it("Medium is 'medium'", () => {
		expect(Effort.Medium).toBe("medium" as typeof Effort.Medium);
	});
	it("High is 'high'", () => {
		expect(Effort.High).toBe("high" as typeof Effort.High);
	});
	it("XHigh is 'xhigh'", () => {
		expect(Effort.XHigh).toBe("xhigh" as typeof Effort.XHigh);
	});
	it("Max is 'max'", () => {
		expect(Effort.Max).toBe("max" as typeof Effort.Max);
	});
});

describe("THINKING_EFFORTS", () => {
	it("has 6 efforts", () => {
		expect(THINKING_EFFORTS).toHaveLength(6);
	});
	it("starts with Minimal", () => {
		expect(THINKING_EFFORTS[0]).toBe(Effort.Minimal);
	});
	it("ends with Max", () => {
		expect(THINKING_EFFORTS[THINKING_EFFORTS.length - 1]).toBe(Effort.Max);
	});
	it("contains all efforts in order", () => {
		expect(THINKING_EFFORTS).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
			Effort.Max,
		]);
	});
});

describe("isEffort", () => {
	it("returns true for 'minimal'", () => {
		expect(isEffort("minimal")).toBe(true);
	});
	it("returns true for 'low'", () => {
		expect(isEffort("low")).toBe(true);
	});
	it("returns true for 'medium'", () => {
		expect(isEffort("medium")).toBe(true);
	});
	it("returns true for 'high'", () => {
		expect(isEffort("high")).toBe(true);
	});
	it("returns true for 'xhigh'", () => {
		expect(isEffort("xhigh")).toBe(true);
	});
	it("returns true for 'max'", () => {
		expect(isEffort("max")).toBe(true);
	});
	it("returns false for 'ultra'", () => {
		expect(isEffort("ultra")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(isEffort("")).toBe(false);
	});
	it("returns false for number", () => {
		expect(isEffort(42)).toBe(false);
	});
	it("returns false for null", () => {
		expect(isEffort(null)).toBe(false);
	});
	it("returns false for undefined", () => {
		expect(isEffort(undefined)).toBe(false);
	});
	it("returns false for object", () => {
		expect(isEffort({})).toBe(false);
	});
	it("returns false for uppercase", () => {
		expect(isEffort("HIGH")).toBe(false);
	});
});

describe("canonicalizeEfforts", () => {
	it("returns empty for empty input", () => {
		expect(canonicalizeEfforts([])).toEqual([]);
	});
	it("returns efforts in canonical order", () => {
		expect(canonicalizeEfforts([Effort.Max, Effort.Minimal])).toEqual([Effort.Minimal, Effort.Max]);
	});
	it("preserves already canonical order", () => {
		expect(canonicalizeEfforts([Effort.Minimal, Effort.Low, Effort.Medium])).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
		]);
	});
	it("removes duplicates", () => {
		expect(canonicalizeEfforts([Effort.High, Effort.High, Effort.Low])).toEqual([Effort.Low, Effort.High]);
	});
	it("handles all efforts in reverse order", () => {
		expect(
			canonicalizeEfforts([Effort.Max, Effort.XHigh, Effort.High, Effort.Medium, Effort.Low, Effort.Minimal]),
		).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);
	});
	it("handles single effort", () => {
		expect(canonicalizeEfforts([Effort.Medium])).toEqual([Effort.Medium]);
	});
	it("handles subset", () => {
		expect(canonicalizeEfforts([Effort.High, Effort.Max])).toEqual([Effort.High, Effort.Max]);
	});
	it("handles all efforts", () => {
		expect(canonicalizeEfforts(THINKING_EFFORTS)).toEqual(THINKING_EFFORTS);
	});
	it("handles all efforts shuffled", () => {
		const shuffled = [Effort.Medium, Effort.Max, Effort.Minimal, Effort.High, Effort.Low, Effort.XHigh];
		expect(canonicalizeEfforts(shuffled)).toEqual(THINKING_EFFORTS);
	});
});
