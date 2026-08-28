export function* batched<T>(items: readonly T[], size: number): Generator<T[]> {
	if (!Number.isInteger(size) || size <= 0) {
		throw new RangeError(`batched: size must be a positive integer, got ${size}`);
	}
	for (let offset = 0; offset < items.length; offset += size) {
		yield items.slice(offset, offset + size);
	}
}
