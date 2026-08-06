import { describe, expect, it } from "bun:test";
import { ToolAbortError, throwIfAborted } from "@veyyon/coding-agent/tools/tool-errors";

/**
 * When work is cancelled, the reason has to reach the person who cancelled it.
 *
 * WHY THIS SUITE EXISTS (TOOLE-1-ABORT). `throwIfAborted` is the abort check for
 * every builtin tool, called from over a hundred places. It used to build its
 * error as `new ToolAbortError(undefined, { cause: signal.reason })`, which puts
 * the reason somewhere nothing reads and leaves the message at its default. Every
 * abort therefore said "Operation aborted": a user pressing Escape, a deadline
 * expiring, a parent tool cancelling a child, and a language server giving up on
 * a request all produced one sentence, and nothing downstream could tell them
 * apart. `lsp/index.ts` had already worked around it in one place by catching the
 * error and rebuilding a message with the elapsed budget and the server name.
 *
 * The reason now travels in the message. That matters beyond tidiness because
 * `session/messages.ts` renders `errorMessage` verbatim unless it is generic, so
 * a reason that reaches the message reaches the operator's screen.
 *
 * The type is still normalized, and that half must not regress either. Around
 * twenty call sites handle an abort with `error instanceof ToolAbortError`, so
 * rethrowing whatever `signal.reason` holds would silently stop those branches
 * from matching. `AbortSignal.reason` is `any`: a string, a `DOMException`, a
 * `TimeoutError`, or `undefined`. One thrown type means one catch.
 */

/** An aborted signal carrying `reason`. */
function abortedWith(reason: unknown): AbortSignal {
	const controller = new AbortController();
	controller.abort(reason);
	return controller.signal;
}

/**
 * A signal whose `reason` is genuinely `undefined`.
 *
 * `controller.abort()` does NOT produce one: the platform substitutes a
 * `DOMException("The operation was aborted.")`, which is why the tests below
 * that want the reasonless branch cannot go through `AbortController`. The
 * branch is still reachable, because `signal` is typed as an interface and the
 * codebase passes mocks and composed signal objects around, so the function has
 * to answer for it rather than assume the platform's substitution.
 */
function abortedWithNoReason(): AbortSignal {
	return { aborted: true, reason: undefined } as AbortSignal;
}

describe("a signal that has not aborted throws nothing", () => {
	/**
	 * KEPT AS AN ABSENCE-OF-THROW CHECK ON PURPOSE. `throwIfAborted` returns void, so the whole
	 * observable contract of its guard clause (`if (!signal?.aborted) return`) is that it does not
	 * throw. It is the overwhelmingly common call on a hot path reached from over a hundred sites,
	 * and an inverted or mistyped guard would turn every live signal into an abort. The three
	 * shapes a caller really passes are covered in one parameterized case rather than three tests
	 * restating one branch.
	 */
	it.each([
		["a live signal", new AbortController().signal, undefined],
		["no signal at all", undefined, undefined],
		["a live signal with an operation name", new AbortController().signal, "reading file"],
	] as const)("returns quietly for %s", (_label, signal, what) => {
		expect(() => throwIfAborted(signal, what)).not.toThrow();
	});
});

describe("the reason reaches the message", () => {
	/**
	 * THE REGRESSION. A string reason is the ordinary spelling in this codebase
	 * (`controller.abort("user interrupted")`) and it used to be dropped.
	 */
	it("uses a string reason as the message", () => {
		expect(() => throwIfAborted(abortedWith("user interrupted"))).toThrow("user interrupted");
	});

	/** An Error reason contributes its message rather than its identity. */
	it("uses an Error reason's message", () => {
		expect(() => throwIfAborted(abortedWith(new Error("deadline exceeded")))).toThrow("deadline exceeded");
	});

	/**
	 * The platform's own abort shape. `AbortController.abort()` with no argument
	 * gives a `DOMException` in some runtimes and `undefined` in others, and both
	 * have to produce something a reader can act on.
	 */
	it("uses a DOMException reason's message", () => {
		const reason = new DOMException("The operation was aborted.", "AbortError");

		expect(() => throwIfAborted(abortedWith(reason))).toThrow("The operation was aborted.");
	});

	/**
	 * Naming the operation prefixes the reason. A bare "deadline exceeded" does
	 * not say what hit the deadline, and the tool knows.
	 */
	it("prefixes the reason with the operation name when both are present", () => {
		expect(() => throwIfAborted(abortedWith("deadline exceeded"), "grep")).toThrow("grep: deadline exceeded");
	});
});

describe("an abort with nothing to say still says what it can", () => {
	/**
	 * A signal with no reason at all has nothing to report, so the default
	 * sentence is correct here. This is the case the old behaviour applied to
	 * EVERY abort.
	 */
	it("falls back to the default sentence for a reasonless abort", () => {
		expect(() => throwIfAborted(abortedWithNoReason())).toThrow(ToolAbortError.MESSAGE);
	});

	/** With an operation name and no reason, the name is what there is to report. */
	it("names the operation when there is no reason", () => {
		expect(() => throwIfAborted(abortedWithNoReason(), "fetching page")).toThrow("fetching page was aborted");
	});

	/**
	 * WHAT THE PLATFORM ACTUALLY DOES, pinned because the two tests above read as
	 * though a bare `controller.abort()` reached them. It does not:
	 * `AbortController` substitutes a `DOMException("The operation was aborted.")`
	 * for a missing reason, so the ordinary cancel path renders that sentence and
	 * takes the reason branch, not the fallback. Anyone reading the fallback tests
	 * would otherwise assume the wrong thing about the common case.
	 */
	it("renders the platform's substituted reason for a bare abort()", () => {
		const controller = new AbortController();
		controller.abort();

		expect(() => throwIfAborted(controller.signal)).toThrow("The operation was aborted.");
		expect(() => throwIfAborted(controller.signal, "fetching page")).toThrow(
			"fetching page: The operation was aborted.",
		);
	});

	/** An empty string is not a reason. Using it would produce an error with no message at all. */
	it("treats an empty string reason as no reason", () => {
		expect(() => throwIfAborted(abortedWith(""))).toThrow(ToolAbortError.MESSAGE);
	});

	/** An Error whose message is empty is the same case, reached by a different route. */
	it("treats an Error with an empty message as no reason", () => {
		expect(() => throwIfAborted(abortedWith(new Error("")))).toThrow(ToolAbortError.MESSAGE);
	});

	/**
	 * A non-string, non-Error reason (a number, an object, null) has no sensible
	 * rendering, so the default stands rather than "[object Object]" reaching a
	 * banner.
	 */
	it("falls back to the default sentence for a reason that is neither string nor Error", () => {
		expect(() => throwIfAborted(abortedWith({ code: 7 }))).toThrow(ToolAbortError.MESSAGE);
		expect(() => throwIfAborted(abortedWith(42))).toThrow(ToolAbortError.MESSAGE);
		expect(() => throwIfAborted(abortedWith(null))).toThrow(ToolAbortError.MESSAGE);
	});
});

describe("the thrown type stays normalized", () => {
	/**
	 * THE HALF THAT MUST NOT REGRESS. Around twenty call sites branch on
	 * `error instanceof ToolAbortError`. Rethrowing `signal.reason` verbatim, the
	 * way `signal.throwIfAborted()` does, would stop every one of them matching,
	 * and the failure would be silent: the abort would simply take the generic
	 * error path instead.
	 */
	it("throws ToolAbortError for a plain Error reason", () => {
		const reason = new Error("boom");
		let caught: unknown;
		try {
			throwIfAborted(abortedWith(reason));
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(ToolAbortError);
		// The precise defect: `signal.throwIfAborted()` rethrows the reason object
		// itself. An `Error` reason would then still be an Error and still carry
		// "boom", so identity is what tells a normalized throw from a rethrow.
		expect(caught).not.toBe(reason);
		expect((caught as Error).message).toBe("boom");
	});

	/** The same for a DOMException, which is the platform's own abort shape. */
	it("throws ToolAbortError for a DOMException reason", () => {
		const reason = new DOMException("aborted", "AbortError");
		let caught: unknown;
		try {
			throwIfAborted(abortedWith(reason));
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(ToolAbortError);
		expect(caught).not.toBe(reason);
		expect((caught as Error).message).toBe("aborted");
	});

	/**
	 * A reason that is ALREADY a `ToolAbortError` is rethrown by identity. A
	 * nested tool cancelling its parent's signal must not have its error rebuilt
	 * at each layer, which would bury the original message under prefixes.
	 */
	it("rethrows a ToolAbortError reason unchanged, by identity", () => {
		const original = new ToolAbortError("inner tool cancelled");
		let caught: unknown;
		try {
			throwIfAborted(abortedWith(original), "outer");
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(original);
		expect((caught as Error).message).toBe("inner tool cancelled");
	});

	/** The error name is part of the contract: it is what `isAbortError` matches on. */
	it("names the error ToolAbortError", () => {
		let caught: unknown;
		try {
			throwIfAborted(abortedWith("stopped"));
		} catch (error) {
			caught = error;
		}

		expect((caught as Error).name).toBe("ToolAbortError");
	});
});

describe("the original reason is still recoverable", () => {
	/**
	 * The message is for people; `cause` is for code. A caller that needs the
	 * `TimeoutError` identity behind an abort must still be able to reach it, so
	 * moving the reason into the message must not have removed it from `cause`.
	 */
	it("keeps the reason object on cause", () => {
		const reason = new DOMException("timed out", "TimeoutError");
		let caught: unknown;
		try {
			throwIfAborted(abortedWith(reason));
		} catch (error) {
			caught = error;
		}

		expect((caught as Error).cause).toBe(reason);
	});

	/** A string reason is preserved on cause as well, not only rendered. */
	it("keeps a string reason on cause", () => {
		let caught: unknown;
		try {
			throwIfAborted(abortedWith("escape pressed"));
		} catch (error) {
			caught = error;
		}

		expect((caught as Error).cause).toBe("escape pressed");
	});
});
