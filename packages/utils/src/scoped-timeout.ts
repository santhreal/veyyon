/** Create an abort signal that fires after a timeout and preserves caller cancellation. */
export function withTimeoutSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

/** Detect a timeout raised by an abortable fetch. */
export function isTimeoutError(error: unknown): boolean {
	return error instanceof Error && error.name === "TimeoutError";
}

/**
 * Cancelable variant of {@link withScopedTimeoutSignal} for call sites whose
 * body doesn't fit a callback: returns a timeout signal (optionally combined
 * with a caller signal) plus a `cancel()` the caller MUST invoke in `finally`
 * so the backing timer never outlives the operation (same Bun-GC-crash
 * rationale as withScopedTimeoutSignal).
 */
export function scopedTimeoutSignal(timeoutMs: number, parent?: AbortSignal): { signal: AbortSignal; cancel(): void } {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
		timeoutMs,
	);
	return {
		signal: parent ? AbortSignal.any([parent, controller.signal]) : controller.signal,
		cancel: () => clearTimeout(timer),
	};
}

/**
 * Run `fn` with an abort signal that fires after `timeoutMs`, clearing the
 * backing timer the instant the operation settles.
 *
 * Unlike the built-in abort-signal timeout API, the timer never outlives the
 * request: on the success path it is cancelled before `fn` resolves, so the
 * signal is never aborted and no pending callback lingers on the heap. A leaked
 * abort-signal timeout (e.g. discovery against a mocked fetch that resolves
 * instantly) fires seconds later and sets its abort `reason` — which crashed
 * Bun's concurrent GC while it marked the signal's wrapped reason during an
 * unrelated allocation (`JSAbortSignal::visitAdditionalChildren`).
 */
export async function withScopedTimeoutSignal<T>(
	timeoutMs: number,
	fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
		timeoutMs,
	);
	try {
		return await fn(controller.signal);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Race `promise` against a scoped deadline. On timeout the returned promise
 * rejects with `makeTimeoutError()` (after awaiting `options.onTimeout`, when
 * given — e.g. to capture diagnostics or kill a stalled worker). When
 * `options.signal` aborts first the race rejects with the signal's reason
 * instead. The backing timer is cleared as soon as any side settles.
 *
 * This is the one promise-vs-deadline racer; `withTimeout` in ./async is a
 * message-string convenience wrapper over it.
 */
export async function raceWithTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	makeTimeoutError: () => Error,
	options?: { onTimeout?: () => Promise<void>; signal?: AbortSignal },
): Promise<T> {
	const { onTimeout, signal } = options ?? {};
	const abortError = (): Error => (signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
	if (signal?.aborted) throw abortError();

	const timeout = scopedTimeoutSignal(timeoutMs, signal);
	const { promise: timeoutPromise, reject } = Promise.withResolvers<never>();
	let timedOut = false;
	const onAbort = (): void => {
		if (signal?.aborted) {
			reject(abortError());
		} else {
			timedOut = true;
			reject(makeTimeoutError());
		}
	};
	timeout.signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([promise, timeoutPromise]);
	} catch (error) {
		if (timedOut) await onTimeout?.();
		throw error;
	} finally {
		timeout.cancel();
		timeout.signal.removeEventListener("abort", onAbort);
	}
}
