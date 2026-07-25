import assert from "node:assert/strict";

/**
 * The error the abortable helpers in this module reject with.
 *
 * IT ADOPTS THE REASON'S NAME. `AbortError` used to stamp `name = "AbortError"`
 * over every reason while taking only the reason's MESSAGE, which erased the one
 * distinction the predicates below exist to preserve. A `scopedTimeoutSignal`
 * deadline aborts its controller with a `DOMException` named `TimeoutError`, so
 * what a caller received was an error named `AbortError` whose message merely
 * happened to read `Aborted: The operation timed out.` — {@link isTimeoutError}
 * was false on it, and the only route back to the truth was to inspect
 * `signal.aborted` on the PARENT signal and infer the answer from its absence.
 *
 * `read.ts` was doing exactly that inference, with a comment naming a timeout
 * that the guard above it could not see as one. The distinction matters to the
 * person reading the error: work they stopped, versus work that ran out of time
 * and may be worth retrying with a longer limit.
 *
 * A reason with no name of its own (a bare `controller.abort()`, a string) still
 * produces `AbortError`, so a plain cancellation is unchanged.
 */
export class AbortError extends Error {
	constructor(signal: AbortSignal) {
		assert(signal.aborted, "Abort signal must be aborted");

		const { reason } = signal;
		const message = reason instanceof Error ? reason.message : "Cancelled";
		super(`Aborted: ${message}`, { cause: reason });
		// Through `errorName` rather than reading `.name` here: that function is
		// this module's owner for "the name of a thrown value", and the predicates
		// below classify by exactly what it returns. A second reading of the same
		// field could disagree with them about an edge (a getter, a non-string
		// name) and the disagreement would be invisible.
		const reasonName = errorName(reason);
		this.name = reasonName !== undefined && reasonName.length > 0 ? reasonName : "AbortError";
	}
}

/** The `name` of a thrown value, for any shape that carries one. */
function errorName(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const name = (error as { name?: unknown }).name;
	return typeof name === "string" ? name : undefined;
}

/**
 * True when an error is a cancellation: something aborted the work.
 *
 * Cancellation reaches a `catch` block wearing several different coats, and which
 * one it is depends on who raised it. `AbortController.abort()` with no reason
 * produces a `DOMException` named `AbortError`; `fetch` propagates that same
 * exception; {@link AbortError} above is a plain `Error` with the same name; and
 * the eval kernels build their own `Error` subclasses and set `name` to match. The
 * only thing all of them share is the NAME, which is why this reads `name` instead
 * of testing an instance. `DOMException` inherits from `Error` under Bun and Node
 * but NOT in a browser, and `@veyyon/utils` code is bundled for the dashboard too,
 * so an `instanceof Error` gate here would quietly stop recognising cancelled
 * fetches in exactly one of the two runtimes. The copies each wrote
 * `instanceof DOMException || instanceof Error` for that reason; reading the name
 * covers both without naming either.
 *
 * The reason this needs one owner: a cancellation caught and reported as a failure
 * is a wrong answer, not just a noisy one. A site scraper that turns the user's
 * Ctrl-C into "the scraper failed, falling back to a generic fetch" then goes on
 * to make the request the user just cancelled. Every place that decides "is this
 * my error or is this the user leaving?" has to agree, and this was written out at
 * least six ways: two private `isAbortError` copies, `isCancellationError` in
 * `eval/executor-base.ts`, and bare `error.name === "AbortError"` comparisons in
 * `agent-loop.ts`, `agent-session.ts`, `utils/yield.ts`, and `stt-controller.ts`.
 */
export function isAbortError(error: unknown): boolean {
	const name = errorName(error);
	// `ToolAbortError` is the coding agent's own cancellation, and its name says so. It is
	// counted here because callers ask "was this cancelled", never "which layer cancelled
	// it": six sites wrote `err.name === "AbortError" || err.name === "ToolAbortError"` by
	// hand for exactly that reason. `@veyyon/utils` cannot import the class (the dependency
	// runs the other way), and it does not need to — the name is the contract.
	return name === "AbortError" || name === "ToolAbortError";
}

/**
 * True when an error is a deadline expiring rather than an explicit cancellation.
 *
 * `AbortSignal.timeout()` raises a `DOMException` named `TimeoutError`, and the
 * eval kernels raise their own errors with that name. Kept separate from
 * {@link isAbortError} because the two mean different things to a user: work they
 * stopped, versus work that ran out of time and may be worth retrying with a
 * longer limit.
 */
export function isTimeoutError(error: unknown): boolean {
	return errorName(error) === "TimeoutError";
}

/**
 * True when an error is either a cancellation or a timeout — the "stop, do not
 * report this as a failure of mine" test.
 *
 * Most callers want this one: both mean the work did not finish for a reason that
 * is not a defect in the code doing the work, so both must propagate rather than
 * be converted into a degraded result.
 */
export function isCancellation(error: unknown): boolean {
	return isAbortError(error) || isTimeoutError(error);
}

/**
 * Abortable async iteration over a {@link ReadableStream}. Reads the source
 * reader directly and yields each chunk, so the consumer's `for await` drives a
 * single read loop with no intermediate stream or per-chunk enqueue.
 *
 * Unlike `stream.pipeThrough(..., { signal })`, this explicitly cancels the
 * source reader on abort or early `break`, propagating HTTP-client disconnects
 * and watchdog timeouts to the backend request instead of only stopping the
 * local consumer. On abort it throws {@link AbortError}; the lock is released
 * on completion, abort, throw, or early exit. The source is cancelled only on
 * abort or early exit — never on natural EOF.
 */
export async function* abortableSource<T>(stream: ReadableStream<T>, signal?: AbortSignal): AsyncGenerator<T> {
	if (signal?.aborted) throw new AbortError(signal);
	const reader = stream.getReader();
	let onAbort: (() => void) | undefined;
	if (signal) {
		onAbort = () => {
			void reader.cancel(signal.reason).catch(() => {});
		};
		signal.addEventListener("abort", onAbort, { once: true });
	}
	let completed = false;
	try {
		for (;;) {
			const result = await reader.read();
			if (signal?.aborted) throw new AbortError(signal);
			if (result.done) {
				completed = true;
				return;
			}
			yield result.value;
		}
	} finally {
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		// Propagate early-exit (`break`/`return`) and abort to the backend; skip
		// on natural EOF where the stream already closed itself.
		if (!completed) {
			try {
				await reader.cancel();
			} catch {}
		}
		try {
			reader.releaseLock();
		} catch {}
	}
}

/**
 * Runs a promise-returning function (`pr`). If the given AbortSignal is aborted before or during
 * execution, the promise is rejected with a standard error.
 *
 * @param signal - Optional AbortSignal to cancel the operation
 * @param pr - Function returning a promise to run
 * @returns Promise resolving as `pr` would, or rejecting on abort
 */
export function untilAborted<T>(
	signal: AbortSignal | undefined | null,
	pr: Promise<T> | (() => Promise<T>),
): Promise<T> {
	if (!signal) return typeof pr === "function" ? pr() : pr;
	if (signal.aborted) return Promise.reject(new AbortError(signal));

	const { promise, resolve, reject } = Promise.withResolvers<T>();
	const onAbort = () => reject(new AbortError(signal));
	signal.addEventListener("abort", onAbort, { once: true });

	void (async () => {
		try {
			resolve(await (typeof pr === "function" ? pr() : pr));
		} catch (err) {
			reject(err);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	})();

	return promise;
}

/**
 * Memoizes a function with no arguments, calling it once and caching the result.
 *
 * @param fn - Function to be called once
 * @returns A function that returns the cached result of `fn`
 */
export function once<T>(fn: () => T): () => T {
	let store = undefined as { value: T } | undefined;
	return () => {
		if (store) {
			return store.value;
		}
		const value = fn();
		store = { value };
		return value;
	};
}
