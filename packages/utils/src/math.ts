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
