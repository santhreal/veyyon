import { describe, expect, it } from "bun:test";
import { createAbortSourceTracker, raceWithSignal } from "../src/utils/abort";

describe("createAbortSourceTracker", () => {
	it("returns tracker with signal and controller", () => {
		const tracker = createAbortSourceTracker();
		expect(tracker.requestAbortController).toBeDefined();
		expect(tracker.requestSignal).toBeDefined();
		expect(tracker.requestSignal.aborted).toBe(false);
	});

	it("abortLocally aborts the signal", () => {
		const tracker = createAbortSourceTracker();
		const reason = new Error("test abort");
		tracker.abortLocally(reason);
		expect(tracker.requestSignal.aborted).toBe(true);
	});

	it("abortLocally returns the reason", () => {
		const tracker = createAbortSourceTracker();
		const reason = new Error("test abort");
		expect(tracker.abortLocally(reason)).toBe(reason);
	});

	it("abortLocally does not overwrite first abort reason", () => {
		const tracker = createAbortSourceTracker();
		const reason1 = new Error("first");
		const reason2 = new Error("second");
		tracker.abortLocally(reason1);
		tracker.abortLocally(reason2);
		expect(tracker.getLocalAbortReason()).toBe(reason1);
	});

	it("getLocalAbortReason returns undefined before abort", () => {
		const tracker = createAbortSourceTracker();
		expect(tracker.getLocalAbortReason()).toBeUndefined();
	});

	it("getLocalAbortReason returns reason after local abort", () => {
		const tracker = createAbortSourceTracker();
		const reason = new Error("local abort");
		tracker.abortLocally(reason);
		expect(tracker.getLocalAbortReason()).toBe(reason);
	});

	it("wasCallerAbort returns false without caller signal", () => {
		const tracker = createAbortSourceTracker();
		expect(tracker.wasCallerAbort()).toBe(false);
	});

	it("wasCallerAbort returns false when caller signal is not aborted", () => {
		const callerController = new AbortController();
		const tracker = createAbortSourceTracker(callerController.signal);
		expect(tracker.wasCallerAbort()).toBe(false);
	});

	it("wasCallerAbort returns true when caller signal is aborted", () => {
		const callerController = new AbortController();
		const tracker = createAbortSourceTracker(callerController.signal);
		callerController.abort();
		expect(tracker.wasCallerAbort()).toBe(true);
	});

	it("getLocalAbortReason returns undefined when caller signal is aborted", () => {
		const callerController = new AbortController();
		const tracker = createAbortSourceTracker(callerController.signal);
		tracker.abortLocally(new Error("local"));
		callerController.abort();
		expect(tracker.getLocalAbortReason()).toBeUndefined();
	});

	it("requestSignal reflects caller abort", () => {
		const callerController = new AbortController();
		const tracker = createAbortSourceTracker(callerController.signal);
		callerController.abort(new Error("caller abort"));
		expect(tracker.requestSignal.aborted).toBe(true);
	});

	it("requestSignal reflects local abort", () => {
		const tracker = createAbortSourceTracker();
		tracker.abortLocally(new Error("local abort"));
		expect(tracker.requestSignal.aborted).toBe(true);
	});

	it("requestSignal reflects both caller and local aborts", () => {
		const callerController = new AbortController();
		const tracker = createAbortSourceTracker(callerController.signal);
		tracker.abortLocally(new Error("local"));
		expect(tracker.requestSignal.aborted).toBe(true);
		callerController.abort();
		expect(tracker.requestSignal.aborted).toBe(true);
	});
});

describe("raceWithSignal", () => {
	it("returns promise result when signal is undefined", async () => {
		const result = await raceWithSignal(Promise.resolve(42), undefined);
		expect(result).toBe(42);
	});

	it("returns promise result when signal is not aborted", async () => {
		const controller = new AbortController();
		const result = await raceWithSignal(Promise.resolve(42), controller.signal);
		expect(result).toBe(42);
	});

	it("rejects when signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort(new Error("aborted"));
		await expect(raceWithSignal(Promise.resolve(42), controller.signal)).rejects.toThrow("aborted");
	});

	it("rejects when signal aborts during pending promise", async () => {
		const controller = new AbortController();
		// A promise that never resolves — the abort is the only way it settles
		const { promise: neverResolves } = Promise.withResolvers<number>();
		// Abort synchronously after the race starts
		queueMicrotask(() => controller.abort(new Error("aborted mid-flight")));
		await expect(raceWithSignal(neverResolves, controller.signal)).rejects.toThrow("aborted");
	});

	it("returns promise result when promise resolves before abort", async () => {
		const controller = new AbortController();
		const fastPromise = Promise.resolve(42);
		const result = await raceWithSignal(fastPromise, controller.signal);
		expect(result).toBe(42);
	});

	it("rejects with RequestAbortError when signal aborts without reason", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(raceWithSignal(Promise.resolve(42), controller.signal)).rejects.toThrow();
	});

	it("returns rejected promise error when signal is not aborted", async () => {
		const controller = new AbortController();
		await expect(raceWithSignal(Promise.reject(new Error("promise error")), controller.signal)).rejects.toThrow(
			"promise error",
		);
	});
});
