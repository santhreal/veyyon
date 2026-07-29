import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { abortDetached, type DetachedAbortTarget } from "@veyyon/coding-agent/session/detached-abort";
import { logger } from "@veyyon/utils";

/**
 * `abortDetached` exists because of a real crash, reported from a live session:
 *
 *     [Unhandled Rejection] AbortError: The operation was aborted.
 *       at abort (packages/agent/src/agent.ts:1010:26)
 *       at abort (packages/coding-agent/src/session/agent-session.ts:10592:15)
 *       at restoreQueuedMessagesToEditor (input-controller.ts:1438:27)
 *
 * The call site was `void this.ctx.session.abort({ reason: USER_INTERRUPT_LABEL })`. `void` discards
 * the value and satisfies the floating-promise lint, but it attaches NO rejection handler, so a
 * rejecting abort escapes to the process. That call site is an Esc keystroke handler, which is the
 * worst possible place for it: pressing Esc to interrupt a turn could take the process down, and
 * the stack blamed the keystroke rather than whichever teardown step actually failed.
 */
describe("abortDetached", () => {
	afterEach(() => {
		// Per-test restore rather than a file-wide logger mutation: a leaked spy on the shared logger
		// would silently swallow warnings in every later test file in the same chunk.
		spyOn(logger, "warn").mockRestore();
	});

	/** Resolves with the metadata of the first `logger.warn`, so the assertion awaits the real signal. */
	function captureWarn() {
		const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
		const spy = spyOn(logger, "warn").mockImplementation(((_message: string, meta?: Record<string, unknown>) => {
			resolve(meta ?? {});
		}) as typeof logger.warn);
		return { warned: promise, spy };
	}

	/**
	 * THE REGRESSION. A rejecting abort must be handled, not escape as an unhandled rejection.
	 *
	 * `logger.warn` firing is the observable proof a rejection handler ran: an unhandled rejection
	 * reaches the process without ever calling it. The metadata is asserted too, because the crash
	 * this replaces named no failing step, and a log line that omits the cause would leave the next
	 * occurrence exactly as undiagnosable as the first.
	 */
	it("handles a rejecting abort and logs the cause with its call site", async () => {
		const { warned } = captureWarn();
		const session: DetachedAbortTarget = {
			abort: () => Promise.reject(new Error("The operation was aborted.")),
		};

		abortDetached(session, "input-controller.restoreQueuedMessagesToEditor.empty", "Interrupted by user");

		expect(await warned).toMatchObject({
			where: "input-controller.restoreQueuedMessagesToEditor.empty",
			error: expect.stringContaining("The operation was aborted."),
		});
	});

	/**
	 * A rejection that is not an `Error` still has to be handled. `AbortController.abort(reason)`
	 * takes an arbitrary reason, so the rejected value here is routinely a string or a DOMException
	 * rather than an Error, and a handler that assumed `error.message` would itself throw inside the
	 * catch -- turning a handled rejection back into an unhandled one.
	 */
	it("handles a non-Error rejection", async () => {
		const { warned } = captureWarn();
		const session: DetachedAbortTarget = { abort: () => Promise.reject("aborted") };

		abortDetached(session, "sdk.agentControl.abort", "Interrupted by user");

		expect(await warned).toMatchObject({ where: "sdk.agentControl.abort" });
	});

	/**
	 * The reason reaches the session verbatim. It is what the transcript renders as the interrupt
	 * label, so a helper that dropped or renamed it would change what the user sees after Esc.
	 */
	it("passes the reason through to the session", () => {
		const calls: unknown[] = [];
		const session: DetachedAbortTarget = {
			abort: options => {
				calls.push(options);
				return Promise.resolve();
			},
		};

		abortDetached(session, "input-controller.abortStreamingTurn", "Interrupted by user");

		expect(calls).toEqual([{ reason: "Interrupted by user" }]);
	});

	/**
	 * Omitting the reason must call `abort()` with nothing, NOT `abort({ reason: undefined })`.
	 * The session branches on `options?.reason`, and an explicitly-present key holding `undefined`
	 * is a different value to a caller that spreads or serializes the options object.
	 */
	it("omits the options object entirely when no reason is given", () => {
		const calls: unknown[] = [];
		const session: DetachedAbortTarget = {
			abort: options => {
				calls.push(options);
				return Promise.resolve();
			},
		};

		abortDetached(session, "test.no-reason");

		expect(calls).toEqual([undefined]);
	});

	/**
	 * The success path stays quiet. A warning on every ordinary Esc would train the reader to ignore
	 * the one line that means something.
	 */
	it("logs nothing when the abort succeeds", async () => {
		const spy = spyOn(logger, "warn").mockImplementation((() => {}) as typeof logger.warn);
		const abortCompleted = Promise.resolve();
		const session: DetachedAbortTarget = { abort: () => abortCompleted };

		abortDetached(session, "input-controller.abortStreamingTurn", "Interrupted by user");
		// Await the very promise the helper chained onto, then drain the microtask its `.catch`
		// would have been queued on. No timer: the settle is already observable.
		await abortCompleted;
		await Promise.resolve();

		expect(spy).not.toHaveBeenCalled();
	});

	/**
	 * Some session doubles and compatibility adapters expose a synchronous abort.
	 * Treating every return as a Promise crashed the Esc handler on `.catch`.
	 */
	it("accepts a synchronous successful abort without logging", () => {
		const spy = spyOn(logger, "warn").mockImplementation((() => {}) as typeof logger.warn);
		const session: DetachedAbortTarget = { abort: () => undefined };

		abortDetached(session, "input-controller.abortStreamingTurn", "Interrupted by user");

		expect(spy).not.toHaveBeenCalled();
	});

	/**
	 * A synchronous abort failure needs the same call-site diagnostics as an
	 * asynchronous rejection instead of escaping from the UI event handler.
	 */
	it("handles a synchronous abort failure", async () => {
		const { warned } = captureWarn();
		const session: DetachedAbortTarget = {
			abort: () => {
				throw new Error("synchronous teardown failed");
			},
		};

		abortDetached(session, "extension-ui-controller.abort", "Interrupted by user");

		expect(await warned).toMatchObject({
			where: "extension-ui-controller.abort",
			error: expect.stringContaining("synchronous teardown failed"),
		});
	});
});
