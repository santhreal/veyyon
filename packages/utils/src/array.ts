/** Yield `items` in contiguous slices of at most `size`. `size` must be a positive integer. */
export function* batched<T>(items: readonly T[], size: number): Generator<T[]> {
	if (!Number.isInteger(size) || size <= 0) {
		throw new RangeError(`batched: size must be a positive integer, got ${size}`);
	}
	for (let offset = 0; offset < items.length; offset += size) {
		yield items.slice(offset, offset + size);
	}
}

/** Count elements matching `pred` without allocating an intermediate array. */
export function countWhere<T>(items: readonly T[], pred: (item: T) => boolean): number {
	let n = 0;
	for (let i = 0; i < items.length; i++) if (pred(items[i])) n++;
	return n;
}

/** Split `items` into `[matching, nonMatching]` in a single pass. */
export function partition<T>(items: readonly T[], pred: (item: T) => boolean): [T[], T[]] {
	const matching: T[] = [],
		rest: T[] = [];
	for (const item of items) (pred(item) ? matching : rest).push(item);
	return [matching, rest];
}
export class IncrementalScan<T> {
	#ref: readonly T[] | undefined;
	#length = 0;
	#result = false;
	constructor(private readonly pred: (item: T) => boolean) {}

	check(items: readonly T[]): boolean {
		if (this.#ref === items && items.length >= this.#length) {
			if (!this.#result) this.#result = items.slice(this.#length).some(this.pred);
		} else this.#result = items.some(this.pred);
		this.#ref = items;
		this.#length = items.length;
		return this.#result;
	}
	reset(): void {
		this.#ref = undefined;
		this.#length = 0;
		this.#result = false;
	}
}
