import { describe, expect, it } from "bun:test";
import { createAbortSourceTracker, raceWithSignal } from "../src/utils/abort";

describe("createAbortSourceTracker", () => {
	it("creates tracker with non-aborted signal", () => {
		const tracker = createAbortSourceTracker();
		expect(tracker.requestSignal.aborted).toBe(false);
		expect(tracker.getLocalAbortReason()).toBeUndefined();
		expect(tracker.wasCallerAbort()).toBe(false);
	});
	it("abortLocally aborts the signal", () => {
		const tracker = createAbortSourceTracker();
		const reason = new Error("local abort");
		tracker.abortLocally(reason);
		expect(tracker.requestSignal.aborted).toBe(true);
		expect(tracker.getLocalAbortReason()).toBe(reason);
	});
	it("abortLocally returns the reason", () => {
		const tracker = createAbortSourceTracker();
		const reason = new Error("test");
		expect(tracker.abortLocally(reason)).toBe(reason);
	});
	it("abortLocally is idempotent", () => {
		const tracker = createAbortSourceTracker();
		const reason1 = new Error("first");
		tracker.abortLocally(reason1);
		const reason2 = new Error("second");
		tracker.abortLocally(reason2);
		expect(tracker.getLocalAbortReason()).toBe(reason1);
	});
	it("wasCallerAbort returns false without caller signal", () => {
		const tracker = createAbortSourceTracker();
		expect(tracker.wasCallerAbort()).toBe(false);
	});
	it("wasCallerAbort returns true when caller signal is aborted", () => {
		const callerController = new AbortController();
		callerController.abort();
		const tracker = createAbortSourceTracker(callerController.signal);
		expect(tracker.wasCallerAbort()).toBe(true);
	});
	it("wasCallerAbort returns false when caller signal is not aborted", () => {
		const callerController = new AbortController();
		const tracker = createAbortSourceTracker(callerController.signal);
		expect(tracker.wasCallerAbort()).toBe(false);
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
		callerController.abort(new Error("caller"));
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
	it("rejects when signal aborts during promise", async () => {
		const controller = new AbortController();
		const { promise, resolve } = Promise.withResolvers<number>();
		const racePromise = raceWithSignal(promise, controller.signal);
		controller.abort(new Error("mid-flight"));
		resolve(42);
		await expect(racePromise).rejects.toThrow("mid-flight");
	});
	it("returns promise result if promise resolves before abort", async () => {
		const controller = new AbortController();
		const result = await raceWithSignal(Promise.resolve(99), controller.signal);
		expect(result).toBe(99);
	});
});
