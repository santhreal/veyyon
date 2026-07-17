/**
 * Index of the first element for which `isBefore` is false — the classic
 * binary-search lower bound over a sorted array.
 */
export function lowerBound<T>(values: readonly T[], isBefore: (value: T) => boolean): number {
	let lo = 0;
	let hi = values.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (isBefore(values[mid] as T)) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}
