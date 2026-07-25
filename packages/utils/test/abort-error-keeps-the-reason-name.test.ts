/**
 * A deadline that crosses an abortable boundary is still a deadline.
 *
 * WHY THIS SUITE EXISTS. `abortable.ts` defines `isTimeoutError` separately from
 * `isAbortError` on purpose, and its own doc says why: the two mean different
 * things to the person reading the error. Work they stopped, versus work that
 * ran out of time and may be worth retrying with a longer limit.
 *
 * `AbortError` then destroyed that distinction at its own boundary. It took the
 * MESSAGE from `signal.reason` but stamped `name = "AbortError"` over whatever
 * the reason was called, so a `scopedTimeoutSignal` deadline — which aborts its
 * controller with a `DOMException` named `TimeoutError` — arrived at the caller
 * as an error named `AbortError` whose message merely happened to read
 * `Aborted: The operation timed out.`. `isTimeoutError` was false on it. The
 * only route back to the truth was to look at `signal.aborted` on the PARENT
 * signal and infer the answer from its absence.
 *
 * Callers were doing exactly that. `read.ts`'s suffix resolver tested
 * `isAbortError`, then returned null when the parent signal was NOT aborted,
 * with a trailing comment calling that case a timeout — a comment naming a
 * condition the guard above it could not see, correct only because the
 * fall-through happened to produce the same result.
 * `glob.ts` reached past the error entirely and tested
 * `isTimeoutError(combinedSignal.reason)`.
 *
 * The constructor now adopts the reason's name, so the error answers for itself.
 * That moved behaviour at every `isAbortError` caller that could receive one of
 * these rejections, since `isAbortError` is now FALSE for a timed-out
 * `untilAborted`; those call sites were swept to `isCancellation` in the same
 * change. These tests pin the boundary itself: what the name is, that the
 * message and cause still survive, that an ordinary cancellation is unchanged,
 * and that `isCancellation` covers both so the swept callers stay correct.
 */
import { describe, expect, it } from "bun:test";
import {
	AbortError,
	isAbortError,
	isCancellation,
	isTimeoutError,
	scopedTimeoutSignal,
	untilAborted,
} from "../src/index";

/** A never-settling task, so only the signal can end the wait. */
function forever(): Promise<never> {
	return new Promise(() => {});
}

describe("AbortError name", () => {
	it("keeps TimeoutError, so a deadline is still recognisable as one", () => {
		// The defect. Before this, `isTimeoutError` was false here and every caller
		// had to infer the answer from a signal it might not even hold.
		const controller = new AbortController();
		controller.abort(new DOMException("The operation timed out", "TimeoutError"));
		const error = new AbortError(controller.signal);
		expect(error.name).toBe("TimeoutError");
		expect(isTimeoutError(error)).toBe(true);
		expect(isAbortError(error)).toBe(false);
		expect(isCancellation(error)).toBe(true);
	});

	it("still reads as AbortError for a plain cancellation", () => {
		// The unchanged half. A bare `controller.abort()` has no name to adopt, so
		// the sentinel stands and the ~40 existing `isAbortError` callers that only
		// ever see user interrupts keep their answer.
		const controller = new AbortController();
		controller.abort();
		const error = new AbortError(controller.signal);
		expect(error.name).toBe("AbortError");
		expect(isAbortError(error)).toBe(true);
		expect(isTimeoutError(error)).toBe(false);
	});

	it("still reads as AbortError when the reason is a string", () => {
		// `controller.abort("user pressed escape")` carries no name either.
		const controller = new AbortController();
		controller.abort("user pressed escape");
		expect(new AbortError(controller.signal).name).toBe("AbortError");
	});

	it("adopts the name of any custom reason, not just TimeoutError", () => {
		// The rule is "the reason names itself", not a special case for one type.
		// The eval kernels raise their own named errors through the same path.
		const controller = new AbortController();
		const reason = new Error("kernel stopped");
		reason.name = "KernelAbortError";
		controller.abort(reason);
		expect(new AbortError(controller.signal).name).toBe("KernelAbortError");
	});

	it("ignores an empty name rather than producing a nameless error", () => {
		// A nameless error defeats every predicate here, so an empty string falls
		// back to the sentinel instead of being adopted.
		const controller = new AbortController();
		const reason = new Error("stopped");
		reason.name = "";
		controller.abort(reason);
		expect(new AbortError(controller.signal).name).toBe("AbortError");
	});

	it("keeps the message and the original reason on cause", () => {
		// Adopting the name must not cost the other two things the error carries;
		// `cause` is how a caller reaches the original DOMException.
		const controller = new AbortController();
		const reason = new DOMException("The operation timed out", "TimeoutError");
		controller.abort(reason);
		const error = new AbortError(controller.signal);
		expect(error.message).toBe("Aborted: The operation timed out");
		expect(error.cause).toBe(reason);
	});

	it("says Cancelled when the reason is not an Error", () => {
		// A bare `controller.abort()` does NOT reach this branch: the platform
		// supplies a `DOMException`, so the message comes from it. Only a
		// non-Error reason falls back, which is worth pinning separately so the
		// fallback is not mistaken for the common case.
		const platform = new AbortController();
		platform.abort();
		expect(new AbortError(platform.signal).message).toBe("Aborted: The operation was aborted.");

		const controller = new AbortController();
		controller.abort({ code: 7 });
		expect(new AbortError(controller.signal).message).toBe("Aborted: Cancelled");
	});
});

describe("untilAborted at the boundary", () => {
	it("rejects a timed-out scoped signal with something isTimeoutError recognises", async () => {
		// The end-to-end shape the callers actually see: `scopedTimeoutSignal` plus
		// `untilAborted` is how read.ts, glob.ts and markit.ts bound their work.
		const { signal, cancel } = scopedTimeoutSignal(10);
		try {
			await untilAborted(signal, forever);
			throw new Error("expected untilAborted to reject");
		} catch (error) {
			expect(isTimeoutError(error)).toBe(true);
			expect(isCancellation(error)).toBe(true);
		} finally {
			cancel();
		}
	});

	it("rejects an operator interrupt as a plain AbortError", async () => {
		// The other direction through the same helper, so the two cannot be
		// confused: an interrupt must not start reading as a deadline.
		const controller = new AbortController();
		const pending = untilAborted(controller.signal, forever);
		controller.abort();
		try {
			await pending;
			throw new Error("expected untilAborted to reject");
		} catch (error) {
			expect(isAbortError(error)).toBe(true);
			expect(isTimeoutError(error)).toBe(false);
		}
	});

	it("distinguishes a parent interrupt from the scoped deadline wrapping it", async () => {
		// `scopedTimeoutSignal(ms, parent)` composes both, and the swept call sites
		// branch on which one fired. If they became indistinguishable, glob would
		// return partial results for an operator interrupt and read would swallow
		// a cancellation as a missing path.
		const parent = new AbortController();
		const { signal, cancel } = scopedTimeoutSignal(60_000, parent.signal);
		const pending = untilAborted(signal, forever);
		parent.abort();
		try {
			await pending;
			throw new Error("expected untilAborted to reject");
		} catch (error) {
			expect(isTimeoutError(error)).toBe(false);
			expect(isCancellation(error)).toBe(true);
		} finally {
			cancel();
		}
	});
});
