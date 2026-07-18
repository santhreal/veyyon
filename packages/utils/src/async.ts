import { raceWithTimeout } from "./scoped-timeout";

/**
 * Wrap a promise with a timeout and optional abort signal.
 * Rejects with the given message if the timeout fires first.
 * Message-string convenience over {@link raceWithTimeout}, the one racer.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string, signal?: AbortSignal): Promise<T> {
	return raceWithTimeout(promise, ms, () => new Error(message), { signal });
}

/**
 * Coalesces rapid-fire writes into one deferred batch. `push` queues a value
 * and returns a promise for the batch flush; the first push of a batch arms a
 * timer (`delayMs`, or a microtask at 0), and every push before it fires joins
 * the same batch and shares the same promise. Used to keep hot paths off
 * synchronous storage (prompt history, model perf).
 */
export class AsyncDrain<T> {
	#queue?: T[];
	#promise = Promise.resolve();

	constructor(readonly delayMs: number = 0) {}

	/** Queue `value`; `hnd` receives the whole batch when the window closes. */
	push(value: T, hnd: (values: T[]) => Promise<void> | void): Promise<void> {
		let queue = this.#queue;
		if (!queue) {
			this.#queue = queue = [];
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			const exec = (): void => {
				try {
					if (this.#queue === queue) {
						this.#queue = undefined;
					}
					resolve(hnd(queue!));
				} catch (error) {
					reject(error);
				}
			};
			if (this.delayMs > 0) {
				setTimeout(exec, this.delayMs);
			} else {
				queueMicrotask(exec);
			}
			this.#promise = promise;
		}
		queue.push(value);
		return this.#promise;
	}
}
