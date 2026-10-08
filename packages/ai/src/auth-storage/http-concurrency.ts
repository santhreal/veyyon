/**
 * Process-wide cap for background authentication HTTP work. Broker refresh
 * sweeps and usage probes share this policy so overlapping callers cannot
 * multiply their individual fan-out into an unbounded aggregate burst.
 */
export const AUTH_HTTP_CONCURRENCY_LIMIT = 8;

type PendingAuthHttpOperation = () => void;

class AuthHttpConcurrencyPolicy {
	#active = 0;
	#queue: PendingAuthHttpOperation[] = [];
	#queueHead = 0;

	run<T>(operation: () => Promise<T>): Promise<T> {
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const start = () => {
			this.#active += 1;
			let pending: Promise<T>;
			try {
				pending = operation();
			} catch (error) {
				this.#release();
				reject(error);
				return;
			}
			void pending.then(
				value => {
					this.#release();
					resolve(value);
				},
				error => {
					this.#release();
					reject(error);
				},
			);
		};

		if (this.#active < AUTH_HTTP_CONCURRENCY_LIMIT) {
			start();
		} else {
			this.#queue.push(start);
		}
		return promise;
	}

	#release(): void {
		this.#active -= 1;
		const next = this.#queue[this.#queueHead];
		if (!next) return;
		this.#queueHead += 1;
		if (this.#queueHead === this.#queue.length) {
			this.#queue = [];
			this.#queueHead = 0;
		}
		next();
	}
}

const authHttpConcurrencyPolicy = new AuthHttpConcurrencyPolicy();

/** Runs one refresh or usage request under the shared authentication HTTP cap. */
export function withAuthHttpConcurrency<T>(operation: () => Promise<T>): Promise<T> {
	return authHttpConcurrencyPolicy.run(operation);
}
