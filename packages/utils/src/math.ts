export function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	if (value < min) return min;
	if (value > max) return max;
	return value;
}

export function clamp01(value: number): number {
	return clamp(value, 0, 1);
}

export function clampLow(value: number, low: number, high: number): number {
	if (!Number.isFinite(value)) return low;
	return Math.max(low, Math.min(value, high));
}
