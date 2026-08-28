import { clampLow } from "@veyyon/utils";

export interface ParallelResult<R> {
	results: (R | undefined)[];
	aborted: boolean;
}

export async function mapWithConcurrencyLimit<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number, signal: AbortSignal) => Promise<R>,
	signal?: AbortSignal,
): Promise<ParallelResult<R>> {
	const normalizedConcurrency = Number.isFinite(concurrency) ? Math.floor(concurrency) : items.length;
	const effectiveConcurrency = normalizedConcurrency > 0 ? normalizedConcurrency : items.length;
	const limit = clampLow(effectiveConcurrency, 1, items.length);
	const results: (R | undefined)[] = new Array(items.length);
	let nextIndex = 0;

	const abortController = new AbortController();
	const workerSignal = signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal;

	let rejectFirst: (error: unknown) => void;
	const firstErrorPromise = new Promise<never>((_, reject) => {
		rejectFirst = reject;
	});

	const worker = async (): Promise<void> => {
		while (true) {
			if (workerSignal.aborted) return;
			const index = nextIndex++;
			if (index >= items.length) return;
			try {
				results[index] = await fn(items[index], index, workerSignal);
			} catch (error) {
				if (!workerSignal.aborted) {
					abortController.abort();
					rejectFirst(error);
					throw error;
				}
			}
		}
	};

	const workers = Array(limit)
		.fill(null)
		.map(() => worker());

	try {
		await Promise.race([Promise.all(workers), firstErrorPromise]);
	} catch (error) {
		if (signal?.aborted) {
			return { results, aborted: true };
		}
		throw error;
	}

	return { results, aborted: signal?.aborted ?? false };
}

export function normalizeConcurrencyLimit(max: number): number {
	const normalizedMax = Number.isFinite(max) ? Math.trunc(max) : 0;
	return normalizedMax > 0 ? normalizedMax : 0;
}

export class Semaphore {
	#max: number;
	#current = 0;
	#queue: Array<() => void> = [];

	constructor(max: number) {
		const normalizedMax = normalizeConcurrencyLimit(max);
		this.#max = normalizedMax > 0 ? normalizedMax : Number.POSITIVE_INFINITY;
	}

	async acquire(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) {
			throw semaphoreAbortReason(signal);
		}
		if (this.#current < this.#max) {
			this.#current++;
			return;
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const queue = this.#queue;
		let waiter: () => void = resolve;
		if (signal) {
			const onAbort = () => {
				const index = queue.indexOf(waiter);
				if (index >= 0) queue.splice(index, 1);
				reject(semaphoreAbortReason(signal));
			};
			waiter = () => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			};
			signal.addEventListener("abort", onAbort, { once: true });
		}
		queue.push(waiter);
		return promise;
	}

	release(): void {
		if (this.#current > 0) this.#current--;
		if (this.#current < this.#max) {
			const next = this.#queue.shift();
			if (next) {
				this.#current++;
				next();
			}
		}
	}

	resize(max: number): void {
		const normalizedMax = normalizeConcurrencyLimit(max);
		this.#max = normalizedMax > 0 ? normalizedMax : Number.POSITIVE_INFINITY;
		while (this.#current < this.#max) {
			const next = this.#queue.shift();
			if (!next) break;
			this.#current++;
			next();
		}
	}
}

function semaphoreAbortReason(signal: AbortSignal): unknown {
	const reason = signal.reason;
	if (reason !== undefined) return reason;
	return new Error("Semaphore acquire aborted");
}
