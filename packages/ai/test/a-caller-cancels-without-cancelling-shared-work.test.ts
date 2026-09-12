/**
 * Shared credential work continues after one caller cancels, while the caller
 * receives its abort reason and releases its listener on every settlement path.
 * These checks exclude provider network behavior and cross-process refresh leases.
 */
import { describe, expect, it } from "bun:test";
import * as AIError from "@veyyon/ai/error";
import { raceWithSignal } from "@veyyon/ai/utils/abort";
import { raceWithTimeout } from "@veyyon/utils/scoped-timeout";

function bounded<T>(promise: Promise<T>): Promise<T> {
	return raceWithTimeout(promise, 1000, () => new Error("Caller cancellation did not settle within one second"));
}

describe("raceWithSignal", () => {
	it("resolves to the promise value when signal is undefined", async () => {
		const result = await bounded(raceWithSignal(Promise.resolve("ok"), undefined));
		expect(result).toBe("ok");
	});

	it("resolves to the promise value when signal never aborts", async () => {
		const controller = new AbortController();
		const result = await bounded(raceWithSignal(Promise.resolve(42), controller.signal));
		expect(result).toBe(42);
	});

	it("propagates underlying promise rejections when signal never aborts", async () => {
		const controller = new AbortController();
		const error = new Error("underlying failure");
		await expect(bounded(raceWithSignal(Promise.reject(error), controller.signal))).rejects.toThrow(
			"underlying failure",
		);
	});

	it("preserves native DOMException when signal aborts without reason mid-flight", async () => {
		const controller = new AbortController();
		const { promise: pendingPromise } = Promise.withResolvers<string>();

		const racePromise = bounded(raceWithSignal(pendingPromise, controller.signal));
		controller.abort();

		await expect(racePromise).rejects.toBe(controller.signal.reason);
	});

	it("preserves native DOMException when signal was already aborted before calling raceWithSignal", async () => {
		const controller = new AbortController();
		controller.abort();

		const { promise: deferred } = Promise.withResolvers<string>();

		await expect(bounded(raceWithSignal(deferred, controller.signal))).rejects.toBe(controller.signal.reason);
	});

	it("uses custom fallback RequestAbortError when controller aborts with null reason", async () => {
		const controller = new AbortController();
		controller.abort(null);

		expect(controller.signal.reason).toBeNull();

		const { promise: pendingPromise } = Promise.withResolvers<string>();
		const racePromise = bounded(raceWithSignal(pendingPromise, controller.signal, "null-reason fallback"));

		await expect(racePromise).rejects.toBeInstanceOf(AIError.RequestAbortError);
		await expect(racePromise).rejects.toThrow("null-reason fallback");
	});

	it("preserves explicit custom signal reason", async () => {
		const controller = new AbortController();
		const customReason = new Error("user cancelled turn");

		const { promise: pendingPromise } = Promise.withResolvers<string>();
		const racePromise = bounded(raceWithSignal(pendingPromise, controller.signal, "fallback message"));
		controller.abort(customReason);

		await expect(racePromise).rejects.toBe(customReason);
		await expect(racePromise).rejects.toThrow("user cancelled turn");
	});

	it.each([false, 0, -0, 0n, Number.NaN, ""])(
		"preserves non-null falsy signal reason %p before and during shared work",
		async reason => {
			for (const alreadyAborted of [true, false]) {
				const controller = new AbortController();
				const { promise } = Promise.withResolvers<string>();
				if (alreadyAborted) controller.abort(reason);
				const caller = bounded(raceWithSignal(promise, controller.signal, "fallback message"));
				if (!alreadyAborted) controller.abort(reason);
				await expect(caller).rejects.toBe(reason);
			}
		},
	);

	it("cleans up abort event listeners on resolve, reject, and abort", async () => {
		const controller = new AbortController();
		let listenerCount = 0;
		const trackingSignal = new Proxy(controller.signal, {
			get(target, prop) {
				if (prop === "addEventListener") {
					return (type: string, listener: EventListener | EventListenerObject, options?: unknown) => {
						listenerCount++;
						return target.addEventListener(type, listener, options as AddEventListenerOptions);
					};
				}
				if (prop === "removeEventListener") {
					return (type: string, listener: EventListener | EventListenerObject, options?: unknown) => {
						listenerCount--;
						return target.removeEventListener(type, listener, options as EventListenerOptions);
					};
				}
				return Reflect.get(target, prop, target);
			},
		});

		// 1. Resolve path cleans up listener
		await bounded(raceWithSignal(Promise.resolve("clean"), trackingSignal));
		expect(listenerCount).toBe(0);

		// 2. Reject path cleans up listener
		await expect(bounded(raceWithSignal(Promise.reject(new Error("fail")), trackingSignal))).rejects.toThrow("fail");
		expect(listenerCount).toBe(0);

		// 3. Abort path cleans up listener
		const { promise: pending } = Promise.withResolvers<string>();
		const racePending = bounded(raceWithSignal(pending, trackingSignal));
		expect(listenerCount).toBe(1);
		controller.abort();
		await expect(racePending).rejects.toBe(controller.signal.reason);
		expect(listenerCount).toBe(0);
	});

	it("keeps the underlying shared promise running even after caller aborts", async () => {
		const controller = new AbortController();
		const { promise: sharedPromise, resolve } = Promise.withResolvers<string>();

		const callerPromise = bounded(raceWithSignal(sharedPromise, controller.signal));
		controller.abort();

		await expect(callerPromise).rejects.toBe(controller.signal.reason);

		// The underlying work still completes for other awaiters
		resolve("shared result");
		const sharedResult = await sharedPromise;
		expect(sharedResult).toBe("shared result");
	});
});
