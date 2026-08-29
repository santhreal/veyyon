import { normalizeConcurrencyLimit } from "./parallel-helpers";

export { mapWithConcurrencyLimit } from "./parallel-helpers";
export { normalizeConcurrencyLimit };

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
