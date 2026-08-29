import { raceWithTimeout } from "./scoped-timeout";

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string, signal?: AbortSignal): Promise<T> {
	return raceWithTimeout(promise, ms, () => new Error(message), { signal });
}

export function prefetch<T>(promise: Promise<T>): Promise<T> {
	promise.catch(() => {});
	return promise;
}
