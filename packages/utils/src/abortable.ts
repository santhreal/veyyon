import assert from "node:assert/strict";

export class AbortError extends Error {
	constructor(signal: AbortSignal) {
		assert(signal.aborted, "Abort signal must be aborted");

		const { reason } = signal;
		const message = reason instanceof Error ? reason.message : "Cancelled";
		super(`Aborted: ${message}`, { cause: reason });
		const reasonName = errorName(reason);
		this.name = reasonName !== undefined && reasonName.length > 0 ? reasonName : "AbortError";
	}
}

export function cancellationError(message = "Request was aborted"): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

function errorName(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const name = (error as { name?: unknown }).name;
	return typeof name === "string" ? name : undefined;
}

export function isAbortError(error: unknown): boolean {
	const name = errorName(error);
	return name === "AbortError" || name === "ToolAbortError";
}

export function isTimeoutError(error: unknown): boolean {
	return errorName(error) === "TimeoutError";
}

export function isCancellation(error: unknown): boolean {
	return isAbortError(error) || isTimeoutError(error);
}

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
