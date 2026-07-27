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
 * Start a promise now and await it later, without an unhandled rejection in between.
 *
 * Startup code kicks off independent discoveries in parallel and awaits each one where its value is
 * actually needed, which can be many statements later. If such a promise rejects before anyone awaits it,
 * the runtime reports an unhandled rejection and, depending on the host, may tear the process down -- for a
 * failure that the consumer site is about to handle properly.
 *
 * So this attaches a passive handler and returns the SAME promise. The failure is not swallowed: whoever
 * awaits the returned promise still receives the rejection in full. Use this only where a real `await`
 * follows; it is not a way to ignore a result nobody reads.
 *
 * @example
 * const contextFiles = prefetch(discoverContextFiles(cwd, agentDir));
 * // ... other startup work ...
 * const files = await contextFiles; // a failure surfaces here, as it should
 */
export function prefetch<T>(promise: Promise<T>): Promise<T> {
	promise.catch(() => {});
	return promise;
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
