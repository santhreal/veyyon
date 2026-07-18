/**
 * Owner tests for the scoped-timeout signal primitives. The scoped variants
 * exist because a bare `AbortSignal.timeout` keeps its backing timer armed
 * after the operation settles, which crashed Bun's concurrent GC when leaked
 * signals aborted later (`JSAbortSignal::visitAdditionalChildren`) — so the
 * load-bearing assertions here are that the timer is dead once the operation
 * finishes or `cancel()` runs.
 */
import { describe, expect, it } from "bun:test";
import {
	isTimeoutError,
	raceWithTimeout,
	scopedTimeoutSignal,
	withScopedTimeoutSignal,
	withTimeoutSignal,
} from "../src/scoped-timeout";

describe("isTimeoutError", () => {
	it("matches only TimeoutError-named errors", () => {
		expect(isTimeoutError(new DOMException("The operation timed out.", "TimeoutError"))).toBe(true);
		expect(isTimeoutError(new DOMException("Aborted", "AbortError"))).toBe(false);
		expect(isTimeoutError(new Error("timeout"))).toBe(false);
		expect(isTimeoutError("TimeoutError")).toBe(false);
		expect(isTimeoutError(undefined)).toBe(false);
	});
});

describe("withTimeoutSignal", () => {
	it("returns a bare timeout signal without a caller signal", () => {
		const signal = withTimeoutSignal(60_000);
		expect(signal.aborted).toBe(false);
	});

	it("propagates a pre-aborted caller signal", () => {
		const controller = new AbortController();
		controller.abort(new Error("caller cancelled"));
		const signal = withTimeoutSignal(60_000, controller.signal);
		expect(signal.aborted).toBe(true);
		expect((signal.reason as Error).message).toBe("caller cancelled");
	});
});

describe("withScopedTimeoutSignal", () => {
	it("aborts the callback signal with a TimeoutError once the deadline passes", async () => {
		await expect(
			withScopedTimeoutSignal(10, async signal => {
				await new Promise(resolve => setTimeout(resolve, 100));
				signal.throwIfAborted();
				return "unreachable";
			}),
		).rejects.toMatchObject({ name: "TimeoutError" });
	});

	it("never aborts the signal after the operation settles inside the deadline", async () => {
		let captured: AbortSignal | undefined;
		const result = await withScopedTimeoutSignal(15, async signal => {
			captured = signal;
			return "done";
		});
		expect(result).toBe("done");
		// The 15ms timer was cleared on settle: waiting past the deadline must
		// not flip the signal — a late abort is exactly the leaked-timer bug.
		await new Promise(resolve => setTimeout(resolve, 40));
		expect(captured?.aborted).toBe(false);
	});
});

describe("scopedTimeoutSignal", () => {
	it("aborts with a TimeoutError after the deadline when never cancelled", async () => {
		const timeout = scopedTimeoutSignal(10);
		try {
			await new Promise(resolve => setTimeout(resolve, 40));
			expect(timeout.signal.aborted).toBe(true);
			expect(isTimeoutError(timeout.signal.reason)).toBe(true);
		} finally {
			timeout.cancel();
		}
	});

	it("cancel() defuses the timer so the signal never aborts", async () => {
		const timeout = scopedTimeoutSignal(10);
		timeout.cancel();
		await new Promise(resolve => setTimeout(resolve, 40));
		expect(timeout.signal.aborted).toBe(false);
	});

	it("combines with a parent signal and preserves the parent's abort reason", () => {
		const parent = new AbortController();
		const timeout = scopedTimeoutSignal(60_000, parent.signal);
		try {
			expect(timeout.signal.aborted).toBe(false);
			parent.abort(new Error("caller cancelled"));
			expect(timeout.signal.aborted).toBe(true);
			expect((timeout.signal.reason as Error).message).toBe("caller cancelled");
			expect(isTimeoutError(timeout.signal.reason)).toBe(false);
		} finally {
			timeout.cancel();
		}
	});

	it("parent aborts still propagate after cancel()", () => {
		const parent = new AbortController();
		const timeout = scopedTimeoutSignal(60_000, parent.signal);
		timeout.cancel();
		parent.abort(new Error("late cancel"));
		expect(timeout.signal.aborted).toBe(true);
		expect((timeout.signal.reason as Error).message).toBe("late cancel");
	});
});

describe("raceWithTimeout", () => {
	it("resolves with the promise value inside the deadline", async () => {
		await expect(raceWithTimeout(Promise.resolve(42), 5_000, () => new Error("too slow"))).resolves.toBe(42);
	});

	it("rejects with the factory error and awaits onTimeout when the deadline fires", async () => {
		let hookRan = false;
		const never = new Promise<never>(() => {});
		await expect(
			raceWithTimeout(never, 10, () => new Error("too slow"), {
				onTimeout: async () => {
					hookRan = true;
				},
			}),
		).rejects.toThrow("too slow");
		expect(hookRan).toBe(true);
	});

	it("propagates the promise's own rejection without invoking onTimeout", async () => {
		let hookRan = false;
		await expect(
			raceWithTimeout(Promise.reject(new Error("worker died")), 5_000, () => new Error("too slow"), {
				onTimeout: async () => {
					hookRan = true;
				},
			}),
		).rejects.toThrow("worker died");
		expect(hookRan).toBe(false);
	});

	it("rejects with the caller signal's reason when it aborts first", async () => {
		const controller = new AbortController();
		const never = new Promise<never>(() => {});
		const race = raceWithTimeout(never, 5_000, () => new Error("too slow"), { signal: controller.signal });
		controller.abort(new Error("caller cancelled"));
		await expect(race).rejects.toThrow("caller cancelled");
	});

	it("rejects immediately when the caller signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort(new Error("already aborted"));
		await expect(
			raceWithTimeout(Promise.resolve(1), 5_000, () => new Error("too slow"), { signal: controller.signal }),
		).rejects.toThrow("already aborted");
	});
});
