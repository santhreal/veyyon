import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getRemainingTimeoutMs,
	isCancellationError,
	isTimedOutCancellation,
	getExecutionDeadlineMs as sharedGetExecutionDeadlineMs,
} from "@veyyon/coding-agent/eval/executor-base";
import { getExecutionDeadlineMs as jlGetExecutionDeadlineMs } from "@veyyon/coding-agent/eval/jl/executor";

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

describe("jl getExecutionDeadlineMs intentional divergence", () => {
	it("returns undefined (no timeout) for a zero timeout, unlike the shared owner", () => {
		expect(jlGetExecutionDeadlineMs({ timeoutMs: 0 })).toBeUndefined();
		// Contrast: the shared owner returns an immediate deadline for t=0.
		expect(typeof sharedGetExecutionDeadlineMs({ timeoutMs: 0 })).toBe("number");
	});

	it("derives a deadline from a positive timeout", () => {
		const before = Date.now();
		const deadline = jlGetExecutionDeadlineMs({ timeoutMs: 5_000 });
		expect(deadline).toBeGreaterThanOrEqual(before + 5_000);
		expect(deadline).toBeLessThanOrEqual(Date.now() + 5_000);
	});

	it("passes an explicit deadline through unchanged", () => {
		expect(jlGetExecutionDeadlineMs({ deadlineMs: 123_456 })).toBe(123_456);
	});

	it("returns undefined when neither deadline nor timeout is set", () => {
		expect(jlGetExecutionDeadlineMs(undefined)).toBeUndefined();
		expect(jlGetExecutionDeadlineMs({})).toBeUndefined();
	});
});

describe("julia cancellation-classification single-owner lock", () => {
	it("jl/executor.ts does not reimplement the AbortError/TimeoutError classification", () => {
		const src = readFileSync(join(import.meta.dir, "..", "..", "src", "eval", "jl", "executor.ts"), "utf8");
		// The classification lives only in executor-base now; a reintroduced
		// private copy would compare error names against these literals.
		expect(src).not.toContain('=== "AbortError"');
		expect(src).not.toContain('=== "TimeoutError"');
	});
});
