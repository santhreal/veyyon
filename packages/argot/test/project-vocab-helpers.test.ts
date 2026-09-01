import { describe, expect, it } from "bun:test";
import { DEFAULT_TOKEN_BUDGET, GENERATOR_REVISION } from "../src/constants";
import { budgetKeyedSignature, type ProjectVocabNotice, resolveTokenBudget } from "../src/project-vocab";

describe("resolveTokenBudget", () => {
	it("returns default for undefined", () => {
		expect(resolveTokenBudget(undefined)).toBe(DEFAULT_TOKEN_BUDGET);
	});
	it("returns positive number", () => {
		expect(resolveTokenBudget(500)).toBe(500);
	});
	it("returns floored number for decimal", () => {
		expect(resolveTokenBudget(500.7)).toBe(500);
	});
	it("returns default for zero and calls notice", () => {
		const notices: ProjectVocabNotice[] = [];
		const result = resolveTokenBudget(0, n => notices.push(n));
		expect(result).toBe(DEFAULT_TOKEN_BUDGET);
		expect(notices).toHaveLength(1);
		expect(notices[0].code).toBe("invalid-token-budget");
	});
	it("returns default for negative and calls notice", () => {
		const notices: ProjectVocabNotice[] = [];
		const result = resolveTokenBudget(-100, n => notices.push(n));
		expect(result).toBe(DEFAULT_TOKEN_BUDGET);
		expect(notices).toHaveLength(1);
	});
	it("returns default for NaN and calls notice", () => {
		const notices: ProjectVocabNotice[] = [];
		const result = resolveTokenBudget(NaN, n => notices.push(n));
		expect(result).toBe(DEFAULT_TOKEN_BUDGET);
		expect(notices).toHaveLength(1);
	});
	it("returns default for Infinity and calls notice", () => {
		const notices: ProjectVocabNotice[] = [];
		const result = resolveTokenBudget(Infinity, n => notices.push(n));
		expect(result).toBe(DEFAULT_TOKEN_BUDGET);
		expect(notices).toHaveLength(1);
	});
	it("returns default for -Infinity and calls notice", () => {
		const notices: ProjectVocabNotice[] = [];
		const result = resolveTokenBudget(-Infinity, n => notices.push(n));
		expect(result).toBe(DEFAULT_TOKEN_BUDGET);
		expect(notices).toHaveLength(1);
	});
	it("does not call notice for valid value", () => {
		const notices: ProjectVocabNotice[] = [];
		resolveTokenBudget(500, n => notices.push(n));
		expect(notices).toHaveLength(0);
	});
	it("does not call notice for undefined", () => {
		const notices: ProjectVocabNotice[] = [];
		resolveTokenBudget(undefined, n => notices.push(n));
		expect(notices).toHaveLength(0);
	});
	it("works without notice callback for invalid value", () => {
		expect(resolveTokenBudget(0)).toBe(DEFAULT_TOKEN_BUDGET);
	});
	it("returns 1 for minimum valid value", () => {
		expect(resolveTokenBudget(1)).toBe(1);
	});
});

describe("budgetKeyedSignature", () => {
	it("returns same sig when budget is default and generator revision is 1", () => {
		// This test is conditional on GENERATOR_REVISION being 1
		if (GENERATOR_REVISION === 1) {
			const sig = "abc123";
			expect(budgetKeyedSignature(sig, DEFAULT_TOKEN_BUDGET)).toBe(sig);
		}
	});
	it("returns hashed sig when budget differs from default", () => {
		const sig = "abc123";
		const result = budgetKeyedSignature(sig, 500);
		expect(result).toHaveLength(32);
		expect(result).not.toBe(sig);
	});
	it("returns hashed sig when budget is default but generator revision > 1", () => {
		if (GENERATOR_REVISION > 1) {
			const sig = "abc123";
			const result = budgetKeyedSignature(sig, DEFAULT_TOKEN_BUDGET);
			expect(result).toHaveLength(32);
			expect(result).not.toBe(sig);
		}
	});
	it("returns same result for same inputs", () => {
		const sig = "abc123";
		expect(budgetKeyedSignature(sig, 500)).toBe(budgetKeyedSignature(sig, 500));
	});
	it("returns different result for different budget", () => {
		const sig = "abc123";
		expect(budgetKeyedSignature(sig, 500)).not.toBe(budgetKeyedSignature(sig, 1000));
	});
	it("returns different result for different sig", () => {
		expect(budgetKeyedSignature("abc", 500)).not.toBe(budgetKeyedSignature("xyz", 500));
	});
	it("returns 32-char hex string", () => {
		const result = budgetKeyedSignature("sig", 500);
		expect(result).toHaveLength(32);
		expect(result).toMatch(/^[0-9a-f]+$/);
	});
});
