export { prefetch, withTimeout } from "./async-helpers";

export class AsyncDrain<T> {
	#queue?: T[];
	#promise = Promise.resolve();

	constructor(readonly delayMs: number = 0) {}

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
