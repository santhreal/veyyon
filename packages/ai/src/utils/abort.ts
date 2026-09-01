import * as AIError from "../error";

export interface AbortSourceTracker {
	requestAbortController: AbortController;
	requestSignal: AbortSignal;
	abortLocally(reason: Error): Error;
	getLocalAbortReason(): Error | undefined;
	wasCallerAbort(): boolean;
}

export function createAbortSourceTracker(callerSignal?: AbortSignal): AbortSourceTracker {
	const requestAbortController = new AbortController();
	const requestSignal = callerSignal
		? AbortSignal.any([callerSignal, requestAbortController.signal])
		: requestAbortController.signal;
	let localAbortReason: Error | undefined;

	return {
		requestAbortController,
		requestSignal,
		abortLocally(reason) {
			if (!requestAbortController.signal.aborted) {
				localAbortReason = reason;
				requestAbortController.abort(reason);
			}
			return reason;
		},
		getLocalAbortReason() {
			if (!localAbortReason || callerSignal?.aborted) return undefined;
			return requestSignal.reason === localAbortReason ? localAbortReason : undefined;
		},
		wasCallerAbort() {
			return callerSignal?.aborted === true;
		},
	};
}

export function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(signal.reason ?? new AIError.RequestAbortError());
	const { promise: aborted, reject } = Promise.withResolvers<never>();
	const onAbort = () => reject(signal.reason ?? new AIError.RequestAbortError());
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([promise, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}
