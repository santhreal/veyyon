import { errorMessage, logger } from "@veyyon/utils";

/**
 * The part of a session this module needs. Structural rather than the concrete `AgentSession`,
 * because the callers that abort without awaiting hold different things: the interactive input
 * controller holds an `AgentSession`, the ACP agent holds a per-connection record's session, and
 * the extension host holds whatever the extension was handed.
 */
export interface DetachedAbortTarget {
	abort(options?: { reason?: string }): Promise<unknown> | undefined;
}

/**
 * Abort a session without awaiting the result, and handle the rejection.
 *
 * `void session.abort(...)` is NOT this. `void` discards the value and silences the
 * floating-promise lint, but it attaches no rejection handler, so an abort that rejects becomes an
 * unhandled rejection. Every caller here is a UI or protocol event handler -- an Esc keystroke, an
 * RPC cancel -- and none of them can await, so the failure surfaced as a process-level
 * `[Unhandled Rejection] AbortError` with a stack pointing into the keystroke handler rather than
 * at whatever actually failed.
 *
 * The abort is best-effort by construction: the caller has already moved on and there is no result
 * to report into. So the rejection is logged with the call site rather than swallowed, which is
 * what makes the next occurrence diagnosable -- the crash this replaces carried no indication of
 * which of the session's several teardown steps rejected.
 */
export function abortDetached(session: DetachedAbortTarget, where: string, reason?: string): void {
	const warn = (error: unknown): void => {
		logger.warn("Detached session abort failed", { where, error: errorMessage(error) });
	};
	try {
		void session.abort(reason === undefined ? undefined : { reason })?.catch(warn);
	} catch (error) {
		warn(error);
	}
}
