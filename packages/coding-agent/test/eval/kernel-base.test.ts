import { describe, expect, it } from "bun:test";
import {
	createAbortError,
	getRemainingTimeMs,
	isTimeoutReason,
	throwIfAborted,
} from "@veyyon/coding-agent/eval/kernel-base";

/**
 * These four helpers encode the timeout/abort contract every language kernel runner
 * relies on to stop a hung or cancelled cell and to tell a user-cancel apart from a
 * deadline. They were untested, and each branch has a real consequence: a wrong
 * "remaining time" starves or never-fires the escalation timer; a mislabeled abort
 * error routes a timeout down the cancel path (or vice versa) so the user sees the
 * wrong message. These pin the exact behavior, including the subtle abort-reason
 * cases discovered empirically.
 *
 * Key subtlety locked here: `AbortController.abort()` with NO reason sets the reason
 * to a DOMException, which IS `instanceof Error`, so throwIfAborted rethrows THAT
 * (name "AbortError", the default message) rather than the caller's fallbackReason.
 * The fallbackReason is used ONLY when the reason is neither an Error nor a string
 * (a number, an object). If that ever changes, cancellation messages regress.
 */

describe("getRemainingTimeMs", () => {
	it("returns undefined when there is no deadline", () => {
		expect(getRemainingTimeMs(undefined)).toBeUndefined();
	});

	it("clamps a past deadline to 0 and reports a future deadline within its window", () => {
		expect(getRemainingTimeMs(Date.now() - 1000)).toBe(0);
		const remaining = getRemainingTimeMs(Date.now() + 5000);
		expect(remaining).toBeGreaterThan(0);
		expect(remaining).toBeLessThanOrEqual(5000);
	});
});

describe("createAbortError", () => {
	it("builds an Error with the given name and message", () => {
		const err = createAbortError("TimeoutError", "deadline exceeded");
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("TimeoutError");
		expect(err.message).toBe("deadline exceeded");
	});
});

describe("throwIfAborted", () => {
	it("does nothing when the signal is undefined or not aborted", () => {
		expect(() => throwIfAborted(undefined, "fb")).not.toThrow();
		expect(() => throwIfAborted(new AbortController().signal, "fb")).not.toThrow();
	});

	it("rethrows the reason verbatim when it is an Error", () => {
		const controller = new AbortController();
		const reason = createAbortError("TimeoutError", "deadline");
		controller.abort(reason);
		expect(() => throwIfAborted(controller.signal, "fb")).toThrow(reason);
	});

	it("wraps a string reason as an AbortError carrying that string as the message", () => {
		const controller = new AbortController();
		controller.abort("user pressed escape");
		try {
			throwIfAborted(controller.signal, "unused fallback");
			throw new Error("expected throw");
		} catch (err) {
			expect((err as Error).name).toBe("AbortError");
			expect((err as Error).message).toBe("user pressed escape");
		}
	});

	it("rethrows the DOMException from a no-reason abort, ignoring the fallback", () => {
		const controller = new AbortController();
		controller.abort();
		try {
			throwIfAborted(controller.signal, "fallback-should-not-appear");
			throw new Error("expected throw");
		} catch (err) {
			expect((err as Error).name).toBe("AbortError");
			expect((err as Error).message).not.toBe("fallback-should-not-appear");
		}
	});

	it("uses the fallback message only for a non-Error, non-string reason", () => {
		for (const reason of [42, { some: "object" }]) {
			const controller = new AbortController();
			controller.abort(reason);
			try {
				throwIfAborted(controller.signal, "fallback-msg");
				throw new Error("expected throw");
			} catch (err) {
				expect((err as Error).name).toBe("AbortError");
				expect((err as Error).message).toBe("fallback-msg");
			}
		}
	});
});

describe("isTimeoutReason", () => {
	it("is true only for a TimeoutError DOMException or Error, false otherwise", () => {
		expect(isTimeoutReason(new DOMException("t", "TimeoutError"))).toBe(true);
		expect(isTimeoutReason(createAbortError("TimeoutError", "t"))).toBe(true);
		expect(isTimeoutReason(new DOMException("a", "AbortError"))).toBe(false);
		expect(isTimeoutReason(createAbortError("AbortError", "a"))).toBe(false);
		expect(isTimeoutReason("TimeoutError")).toBe(false);
		expect(isTimeoutReason(null)).toBe(false);
	});
});
