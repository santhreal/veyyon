import { describe, expect, it } from "bun:test";

import {
	getRemainingTimeoutMs,
	isCancellationError,
	isTimedOutCancellation,
	getExecutionDeadlineMs as sharedGetExecutionDeadlineMs,
} from "@veyyon/coding-agent/eval/executor-base";
import { deadlineForNonZeroTimeout, executeJulia } from "@veyyon/coding-agent/eval/jl/executor";

/**
 * The Julia executor used to carry byte-diverged private copies of
 * `isCancellationError`, `isTimedOutCancellation`, and `getRemainingTimeoutMs`.
 * They now delegate to the single owner in `executor-base.ts`. These tests lock
 * the shared owner's behavior (which py, rb, and jl all depend on) and the ONE
 * intentional remaining difference: jl's `getExecutionDeadlineMs` treats a zero
 * timeout as "no timeout", while the shared version treats it as an immediate
 * deadline.
 */

// A stand-in for a language executor's cancelled-error class, matching the
// `CancelledErrorClass` contract `new (timedOut: boolean) => Error & { timedOut }`.
class TestCancelledError extends Error {
	constructor(readonly timedOut: boolean) {
		super(timedOut ? "timed out" : "cancelled");
		this.name = "TestCancelledError";
	}
}

describe("isCancellationError (shared owner)", () => {
	it("recognizes the cancelled-error class", () => {
		expect(isCancellationError(new TestCancelledError(true), TestCancelledError)).toBe(true);
		expect(isCancellationError(new TestCancelledError(false), TestCancelledError)).toBe(true);
	});

	it("recognizes AbortError and TimeoutError by name", () => {
		const abort = new Error("stop");
		abort.name = "AbortError";
		const timeout = new Error("slow");
		timeout.name = "TimeoutError";
		expect(isCancellationError(abort, TestCancelledError)).toBe(true);
		expect(isCancellationError(timeout, TestCancelledError)).toBe(true);
	});

	it("recognizes a DOMException abort/timeout reason explicitly", () => {
		// This is the robustness the private jl copy only got by accident (Bun
		// makes DOMException an Error subclass); the shared owner handles it
		// regardless of that runtime detail.
		expect(isCancellationError(new DOMException("x", "AbortError"), TestCancelledError)).toBe(true);
		expect(isCancellationError(new DOMException("x", "TimeoutError"), TestCancelledError)).toBe(true);
	});

	it("returns false for an ordinary error and non-error values", () => {
		expect(isCancellationError(new Error("boom"), TestCancelledError)).toBe(false);
		expect(isCancellationError(undefined, TestCancelledError)).toBe(false);
		expect(isCancellationError("AbortError", TestCancelledError)).toBe(false);
	});
});

describe("isTimedOutCancellation (shared owner)", () => {
	it("reads timedOut off the cancelled-error class", () => {
		expect(isTimedOutCancellation(new TestCancelledError(true), TestCancelledError)).toBe(true);
		expect(isTimedOutCancellation(new TestCancelledError(false), TestCancelledError)).toBe(false);
	});

	it("treats a TimeoutError as timed out but an AbortError as not", () => {
		const timeout = new Error("slow");
		timeout.name = "TimeoutError";
		const abort = new Error("stop");
		abort.name = "AbortError";
		expect(isTimedOutCancellation(timeout, TestCancelledError)).toBe(true);
		expect(isTimedOutCancellation(abort, TestCancelledError)).toBe(false);
	});

	it("classifies a DOMException TimeoutError signal reason as a timeout", () => {
		const signal = AbortSignal.timeout(0);
		// The reason may not be populated synchronously; construct the reason
		// explicitly to assert the DOMException branch deterministically.
		const reason = new DOMException("timed out", "TimeoutError");
		expect(isTimedOutCancellation(reason, TestCancelledError, signal)).toBe(true);
		const abortReason = new DOMException("aborted", "AbortError");
		expect(isTimedOutCancellation(abortReason, TestCancelledError, signal)).toBe(false);
	});
});

describe("getRemainingTimeoutMs (shared owner)", () => {
	it("returns undefined when there is no deadline", () => {
		expect(getRemainingTimeoutMs(undefined)).toBeUndefined();
	});

	it("returns a positive value for a future deadline", () => {
		const remaining = getRemainingTimeoutMs(Date.now() + 10_000);
		expect(remaining).toBeGreaterThan(0);
		expect(remaining).toBeLessThanOrEqual(10_000);
	});

	it("returns a negative value for a past deadline (callers are negative-safe)", () => {
		// The shared owner does NOT floor at zero; jl's two call sites either
		// re-floor with Math.max(0, ...) or test `<= 0`, so a negative value is
		// safe. This documents that contract.
		expect(getRemainingTimeoutMs(Date.now() - 5_000)).toBeLessThan(0);
	});
});

/**
 * Julia's zero-timeout rule, and the reason it has its own NAME.
 *
 * The behaviour was always deliberate; what was wrong is that it was called
 * `getExecutionDeadlineMs`, the same name as the shared owner in
 * `executor-base`, so two different answers to "when does this expire" shared
 * one identifier and a call site that imported the wrong one still compiled.
 * `deadlineForNonZeroTimeout` says which rule it is. These cases pin both sides
 * of the difference, because asserting only jl's answer would pass if the shared
 * owner quietly adopted the same rule and left the split undocumented.
 */
describe("deadlineForNonZeroTimeout is Julia's rule and says so in its name", () => {
	it("returns undefined (no timeout) for a zero timeout, unlike the shared owner", () => {
		expect(deadlineForNonZeroTimeout({ timeoutMs: 0 })).toBeUndefined();
		// Contrast: the shared owner returns an immediate deadline for t=0.
		expect(typeof sharedGetExecutionDeadlineMs({ timeoutMs: 0 })).toBe("number");
	});

	it("derives a deadline from a positive timeout", () => {
		const before = Date.now();
		const deadline = deadlineForNonZeroTimeout({ timeoutMs: 5_000 });
		expect(deadline).toBeGreaterThanOrEqual(before + 5_000);
		expect(deadline).toBeLessThanOrEqual(Date.now() + 5_000);
	});

	it("passes an explicit deadline through unchanged", () => {
		expect(deadlineForNonZeroTimeout({ deadlineMs: 123_456 })).toBe(123_456);
	});

	it("returns undefined when neither deadline nor timeout is set", () => {
		expect(deadlineForNonZeroTimeout(undefined)).toBeUndefined();
		expect(deadlineForNonZeroTimeout({})).toBeUndefined();
	});
});

describe("julia cancellation-classification single-owner lock", () => {
	/**
	 * The Julia executor carries two thin wrappers that bind its cancelled-error class and delegate to
	 * `executor-base`. What makes the delegation load-bearing rather than cosmetic is stated in
	 * `jl/executor.ts` itself: the shared version inspects the abort REASON as well as the error, and
	 * the private copies it replaced only caught a DOMException because Bun happens to make
	 * DOMException a subclass of Error.
	 *
	 * So the lock is driven through `executeJulia` with an already-aborted signal instead of scanning
	 * `jl/executor.ts` for `=== "AbortError"`. That path classifies and returns before any Julia
	 * runtime is looked up, so no interpreter is needed, and the classification is observable: a
	 * timeout is annotated as a timeout and a plain abort as a cancellation. A reintroduced private
	 * copy that keys on the error name alone reads the timeout case as a generic cancellation and
	 * turns this red, which the character scan could only do if the copy also happened to be spelled
	 * the same way.
	 */
	/** An aborted signal carrying `reason`, built without a real timer. */
	function abortedWith(reason: DOMException): AbortSignal {
		const controller = new AbortController();
		controller.abort(reason);
		return controller.signal;
	}

	it("reads a timeout reason off the signal, not just off the error", async () => {
		const signal = abortedWith(new DOMException("deadline reached", "TimeoutError"));

		const result = await executeJulia("1 + 1", { signal });

		expect(result.output).toContain("timed out");
	});

	it("still calls a plain abort a cancellation rather than a timeout", async () => {
		const signal = abortedWith(new DOMException("user stopped it", "AbortError"));

		const result = await executeJulia("1 + 1", { signal });

		expect(result.output).toBe("[execution cancelled]\n");
	});
});
