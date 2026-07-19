/**
 * Yield `items` in contiguous slices of at most `size`, in order. The final
 * slice may be shorter than `size`; an empty input yields nothing.
 *
 * Use this to batch an array into fixed-size groups instead of hand-rolling an
 * `for (let offset = 0; offset < items.length; offset += size)` loop. Two common
 * uses: staying under SQLite's bound-parameter limit when building an
 * `IN (?, ?, …)` clause, and capping the size of an outbound request or
 * background task.
 *
 * `size` must be a positive integer. A zero or negative size would make the
 * offset loop never advance and spin forever, so this throws instead of
 * silently degrading. The yielded slices are fresh arrays (via `slice`), so a
 * caller may keep or mutate one without affecting `items`.
 */
export function* batched<T>(items: readonly T[], size: number): Generator<T[]> {
	if (!Number.isInteger(size) || size <= 0) {
		throw new RangeError(`batched: size must be a positive integer, got ${size}`);
	}
	for (let offset = 0; offset < items.length; offset += size) {
		yield items.slice(offset, offset + size);
	}
}
