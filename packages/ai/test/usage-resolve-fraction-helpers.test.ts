import { describe, expect, it } from "bun:test";
import { resolveUsedFraction, type UsageLimit } from "../src/usage";

function makeLimit(amount: Partial<UsageLimit["amount"]> & { unit?: UsageLimit["amount"]["unit"] }): UsageLimit {
	return {
		id: "test",
		label: "test limit",
		scope: { provider: "test" },
		amount: { unit: amount.unit ?? "tokens", ...amount },
	};
}

describe("resolveUsedFraction", () => {
	it("returns usedFraction when provided", () => {
		expect(resolveUsedFraction(makeLimit({ usedFraction: 0.5 }))).toBe(0.5);
	});
	it("returns used/limit when both provided and limit > 0", () => {
		expect(resolveUsedFraction(makeLimit({ used: 50, limit: 100 }))).toBe(0.5);
	});
	it("returns undefined when limit is 0", () => {
		expect(resolveUsedFraction(makeLimit({ used: 50, limit: 0 }))).toBeUndefined();
	});
	it("returns undefined when used is undefined", () => {
		expect(resolveUsedFraction(makeLimit({ limit: 100 }))).toBeUndefined();
	});
	it("returns undefined when limit is undefined", () => {
		expect(resolveUsedFraction(makeLimit({ used: 50 }))).toBeUndefined();
	});
	it("returns used/100 for percent unit", () => {
		expect(resolveUsedFraction(makeLimit({ used: 75, unit: "percent" }))).toBe(0.75);
	});
	it("returns 0 for percent with used 0", () => {
		expect(resolveUsedFraction(makeLimit({ used: 0, unit: "percent" }))).toBe(0);
	});
	it("returns 1 - remainingFraction when remainingFraction provided", () => {
		expect(resolveUsedFraction(makeLimit({ remainingFraction: 0.3 }))).toBe(0.7);
	});
	it("returns 0 when remainingFraction is 1", () => {
		expect(resolveUsedFraction(makeLimit({ remainingFraction: 1 }))).toBe(0);
	});
	it("returns 0 when remainingFraction > 1 (clamped)", () => {
		expect(resolveUsedFraction(makeLimit({ remainingFraction: 1.5 }))).toBe(0);
	});
	it("prefers usedFraction over used/limit", () => {
		expect(resolveUsedFraction(makeLimit({ usedFraction: 0.9, used: 10, limit: 100 }))).toBe(0.9);
	});
	it("prefers used/limit over percent", () => {
		expect(resolveUsedFraction(makeLimit({ used: 50, limit: 200, unit: "percent" }))).toBe(0.25);
	});
	it("returns undefined when no fields provided", () => {
		expect(resolveUsedFraction(makeLimit({}))).toBeUndefined();
	});
});
