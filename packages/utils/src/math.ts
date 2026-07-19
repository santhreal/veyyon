/**
 * Small numeric helpers shared across packages.
 *
 * These exist so a value like a normalized ratio is clamped the same way
 * everywhere. Hand-rolled copies drifted: some let `NaN` pass straight through
 * (`NaN < 0` and `NaN > 1` are both false), while others mapped it to `0`, so
 * the same-named `clamp01` returned different results for the same input in two
 * files of one package. Import these instead of writing another copy.
 */

/**
 * Clamp a value into the inclusive range `[min, max]`.
 *
 * A non-finite input (`NaN`, `Infinity`, `-Infinity`) returns `min`, so a
 * broken upstream computation fails to a defined low bound rather than
 * propagating `NaN` through the caller.
 */
export function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	if (value < min) return min;
	if (value > max) return max;
	return value;
}

/**
 * Clamp a value into the inclusive range `[0, 1]`, the common shape for
 * opacity, easing, and normalized scores. `NaN` and infinities return `0`.
 */
export function clamp01(value: number): number {
	return clamp(value, 0, 1);
}

/**
 * Clamp `value` into `[low, high]`, but when the range is empty (`high < low`)
 * the LOW bound wins. This is the textbook `Math.max(low, Math.min(value, high))`
 * form, and it differs from {@link clamp} only in that degenerate case: an index
 * clamped into a list of length zero (`low = 0`, `high = len - 1 = -1`) lands on
 * `0`, not on the inverted `-1` that {@link clamp} would return. Use this for
 * index, offset, and scroll math where an empty range must fall to the low bound
 * rather than below it. A non-finite `value` also returns `low`, so a broken
 * upstream computation fails to a defined bound instead of propagating `NaN`.
 */
export function clampLow(value: number, low: number, high: number): number {
	if (!Number.isFinite(value)) return low;
	return Math.max(low, Math.min(value, high));
}
