export function withTimeoutSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

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
