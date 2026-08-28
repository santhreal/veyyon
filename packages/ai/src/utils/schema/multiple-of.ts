export function isMultipleOf(value: number, multipleOf: number): boolean {
	if (!(multipleOf > 0)) return true;
	const quotient = value / multipleOf;
	const nearest = Math.round(quotient);
	return Math.abs(quotient - nearest) <= 1e-9 * Math.max(1, Math.abs(quotient));
}
