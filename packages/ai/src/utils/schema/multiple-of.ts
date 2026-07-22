/**
 * The single owner of the JSON Schema `multipleOf` test.
 *
 * `value % multipleOf === 0` is wrong for fractional divisors: floating-point
 * representation makes `0.3 % 0.1` equal `0.09999999999999998` and
 * `19.99 % 0.01` equal `0.009999999999998021`, so a naive remainder rejects
 * values that are exact multiples in decimal. Dividing and comparing the
 * quotient to its nearest integer is the standard workaround, but a FIXED
 * absolute tolerance (`Number.EPSILON * 10`) is still too tight once the
 * quotient is large: the float error of `19.99 / 0.01` is about
 * `1999 * Number.EPSILON`, which dwarfs a constant epsilon. The tolerance must
 * therefore scale with the quotient magnitude.
 *
 * A non-positive `multipleOf` is not a real divisibility constraint (JSON Schema
 * requires `multipleOf > 0`, and `value % 0` is `NaN`); callers validate the
 * schema shape separately, so this treats it as "no constraint" and returns
 * true rather than rejecting every value.
 */
export function isMultipleOf(value: number, multipleOf: number): boolean {
	if (!(multipleOf > 0)) return true;
	const quotient = value / multipleOf;
	const nearest = Math.round(quotient);
	// Relative tolerance: scale with the quotient so currency-scale and
	// large-magnitude values are judged as accurately as small ones.
	return Math.abs(quotient - nearest) <= 1e-9 * Math.max(1, Math.abs(quotient));
}
