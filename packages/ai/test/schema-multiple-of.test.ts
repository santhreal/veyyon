import { describe, expect, it } from "bun:test";
import { isMultipleOf } from "@veyyon/ai/utils/schema";

/**
 * `isMultipleOf` is the single owner of the JSON Schema `multipleOf` test, used
 * by both the in-tree JSON Schema validator and the typebox runtime shim. It
 * exists because a naive `value % multipleOf === 0` is wrong for fractional
 * divisors (floating point makes `0.3 % 0.1` non-zero) and because a fixed
 * absolute tolerance on the quotient is still too tight once the quotient is
 * large (currency-scale values like 19.99 / 0.01). These pin the exact-multiple
 * verdict across the ranges that broke the two prior implementations.
 */
describe("isMultipleOf handles floating-point divisors at any scale", () => {
	it("accepts exact decimal multiples that a naive remainder rejects", () => {
		// `0.3 % 0.1` is 0.09999999999999998 and `19.99 % 0.01` is
		// 0.009999999999998021, so a `%`-based check wrongly rejected both.
		expect(isMultipleOf(0.3, 0.1)).toBe(true);
		expect(isMultipleOf(19.99, 0.01)).toBe(true);
		expect(isMultipleOf(123.456, 0.001)).toBe(true);
	});

	it("accepts currency-scale and large-magnitude multiples", () => {
		// The quotient here is ~1e8; a fixed `Number.EPSILON * 10` tolerance was
		// far smaller than this quotient's own float error and rejected it.
		expect(isMultipleOf(1_000_000.05, 0.01)).toBe(true);
		expect(isMultipleOf(100, 0.01)).toBe(true);
	});

	it("rejects genuine non-multiples", () => {
		expect(isMultipleOf(0.35, 0.1)).toBe(false);
		expect(isMultipleOf(2.6, 0.5)).toBe(false);
		expect(isMultipleOf(10, 3)).toBe(false);
		expect(isMultipleOf(1_000_000.055, 0.01)).toBe(false);
		expect(isMultipleOf(123.4565, 0.001)).toBe(false);
	});

	it("handles integers, zero, and negative values", () => {
		expect(isMultipleOf(10, 2)).toBe(true);
		expect(isMultipleOf(7, 7)).toBe(true);
		expect(isMultipleOf(0, 5)).toBe(true); // zero is a multiple of everything
		expect(isMultipleOf(-6, 3)).toBe(true);
		expect(isMultipleOf(-7, 3)).toBe(false);
	});

	it("treats a non-positive divisor as no constraint (JSON Schema requires > 0)", () => {
		// `value % 0` is NaN; a divisibility test against a non-positive divisor is
		// not a real constraint, so it must not reject every value. Schema-shape
		// validation flags the invalid `multipleOf` separately.
		expect(isMultipleOf(5, 0)).toBe(true);
		expect(isMultipleOf(5, -1)).toBe(true);
	});
});
