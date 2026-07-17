/**
 * Wrap a promise with a timeout and optional abort signal.
 * Rejects with the given message if the timeout fires first.
 * Cleans up all listeners on settlement.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string, signal?: AbortSignal): Promise<T> {
	if (signal?.aborted) {
		const reason = signal.reason instanceof Error ? signal.reason : new Error("Aborted");
		return Promise.reject(reason);
	}

	const { promise: wrapped, resolve, reject } = Promise.withResolvers<T>();
	let settled = false;
	const timeoutId = setTimeout(() => {
		if (settled) return;
		settled = true;
		if (signal) signal.removeEventListener("abort", onAbort);
		reject(new Error(message));
	}, ms);

	const onAbort = () => {
		if (settled) return;
		settled = true;
		clearTimeout(timeoutId);
		reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
	};

	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
	}

	promise.then(
		value => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			if (signal) signal.removeEventListener("abort", onAbort);
			resolve(value);
		},
		err => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			if (signal) signal.removeEventListener("abort", onAbort);
			reject(err);
		},
	);

	return wrapped;
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

/**
 * Resolve after `ms`, or reject with the signal's abort reason if aborted
 * first (immediately when already aborted). Aborted signals always carry a
 * reason per spec; the DOMException fallback covers synthetic signals.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	const reasonOf = (): unknown => signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
	if (signal?.aborted) return Promise.reject(reasonOf());
	if (ms <= 0) return Promise.resolve();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const onAbort = (): void => {
		clearTimeout(timer);
		reject(reasonOf());
	};
	const timer = setTimeout(() => {
		signal?.removeEventListener("abort", onAbort);
		resolve();
	}, ms);
	signal?.addEventListener("abort", onAbort, { once: true });
	return promise;
}

/**
 * Run `worker` over `items` with at most `limit` concurrent invocations,
 * returning results in input order. `limit` values below 1 are clamped to 1 —
 * a zero limit must never silently skip the work.
 */
export async function runWithConcurrency<T, R>(
	items: T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (true) {
			const current = nextIndex;
			nextIndex += 1;
			if (current >= items.length) return;
			results[current] = await worker(items[current] as T, current);
		}
	});
	await Promise.all(runners);
	return results;
}
