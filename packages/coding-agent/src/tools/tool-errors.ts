/**
 * Standardized error types for tool execution.
 *
 * Tools should throw these instead of returning error text.
 * The agent loop catches and renders them appropriately.
 */
import { errorMessage, isAbortError } from "@veyyon/utils";

/**
 * Base error for tool execution failures.
 * Override render() for custom LLM-facing formatting.
 */
export class ToolError extends Error {
	constructor(
		message: string,
		readonly context?: Record<string, unknown>,
	) {
		super(message);
		this.name = "ToolError";
	}

	/** Render error for LLM consumption. Override for custom formatting. */
	render(): string {
		return this.message;
	}
}

/**
 * Error thrown when a tool operation is aborted (e.g., via AbortSignal).
 */
export class ToolAbortError extends Error {
	static readonly MESSAGE = "Operation aborted";

	constructor(message: string = ToolAbortError.MESSAGE, options?: ErrorOptions) {
		super(message, options);
		this.name = "ToolAbortError";
	}
}

/**
 * The sentence to show for an abort, given whatever the signal was aborted with.
 *
 * `AbortSignal.reason` is `any`: a string from `controller.abort("deadline")`, a
 * `DOMException` from the platform, a `TimeoutError`, or `undefined` from a bare
 * `controller.abort()`. Each of those has something to say, and this is the one
 * place that decides how to say it. `what` names the operation, for the case
 * where the signal itself carries nothing.
 */
function abortMessage(reason: unknown, what?: string): string {
	const detail =
		typeof reason === "string" && reason.length > 0
			? reason
			: reason instanceof Error && reason.message.length > 0
				? reason.message
				: undefined;
	if (detail !== undefined) return what === undefined ? detail : `${what}: ${detail}`;
	return what === undefined ? ToolAbortError.MESSAGE : `${what} was aborted`;
}

/**
 * Throw {@link ToolAbortError} when `signal` has already been aborted.
 *
 * Use this rather than `signal.throwIfAborted()`. The platform method throws
 * whatever `signal.reason` happens to hold, which is a different type for every
 * caller, and the twenty-odd places that handle an abort in this codebase test
 * `instanceof ToolAbortError`. One type means one catch.
 *
 * The reason travels in the MESSAGE, not only in `cause`. It used to be put in
 * `cause` alone, so every abort read "Operation aborted" whatever had happened:
 * a user pressing Escape, a deadline expiring, and a parent tool cancelling a
 * child all produced the same sentence, and nothing downstream could tell them
 * apart. `session/messages.ts` renders `errorMessage` verbatim unless it is
 * generic, so a reason that reaches the message reaches the operator, and the
 * banner stops saying nothing for the aborts that had something to say.
 *
 * @param what Names the operation, used when the signal carries no reason.
 */
export function throwIfAborted(signal?: AbortSignal, what?: string): void {
	if (!signal?.aborted) return;
	throw toolAbort(signal.reason, what);
}

/**
 * The {@link ToolAbortError} to throw for `reason`, preserving what it said.
 *
 * {@link throwIfAborted} covers the common case where the reason lives on a
 * signal. This is the same decision for the case where it does not: a caught
 * `AbortError` from a platform API, where the ERROR is the only thing carrying
 * why the operation stopped. Both go through here so the two cannot disagree
 * about what an abort reads as, which they did — `mcp/tool-bridge.ts` minted a
 * bare `new ToolAbortError()` for a caught abort, so an MCP call cancelled by an
 * expired deadline reached the operator as the generic "Operation aborted" and
 * the `TimeoutError` identity that tells a deadline from an Escape went with it.
 *
 * An existing `ToolAbortError` is returned unchanged rather than rewrapped: it
 * is already the right type and already carries its message and cause.
 *
 * @param what Names the operation, used when the reason carries nothing.
 */
export function toolAbort(reason: unknown, what?: string): ToolAbortError {
	if (reason instanceof ToolAbortError) return reason;
	return new ToolAbortError(abortMessage(reason, what), { cause: reason });
}

/**
 * The error to throw for a tool failure, WITHOUT flattening a cancellation into
 * one.
 *
 * Use `throw toolFailure(error)` instead of a bare
 * `throw new ToolError(errorMessage(error))`, which is
 * what nine sites across seven tools used to write. That line reads as a
 * formatting step and is not one: it replaces whatever was thrown with a fresh
 * object, so the name, the type, `cause` and any `ToolError.context` are gone. It
 * costs nothing visible, because the MESSAGE is preserved and the message is what
 * a reader looks at.
 *
 * What it costs is the ability of anything downstream to tell a cancellation from
 * a failure. `write`'s atomic-commit path is the sharpest case: it calls
 * `throwIfAborted` immediately before the rename precisely so a cancelled write
 * leaves the original file intact, and then the surrounding catch rebuilt that
 * `ToolAbortError` as a `ToolError`. The file was safe and the SIGNAL was lost, so
 * the agent loop saw an ordinary write failure and its correct response to that is
 * to try the write again.
 *
 * A `ToolError` is passed through rather than rewrapped for the same reason: it is
 * already the right type, and rebuilding it discards the `context` record it
 * carries. Only a foreign error becomes a new `ToolError`.
 *
 * It RETURNS the error rather than throwing it, so the `throw` stays visible at
 * the call site. A `never`-returning helper reads slightly shorter and costs the
 * reader the ability to see that the line terminates, which in a catch block is
 * the only thing about it worth seeing.
 *
 * @param what Optional message replacing the error's own, for the cases that want
 *   to say something more useful than the underlying failure did.
 */
export function toolFailure(error: unknown, what?: string): Error {
	if (isAbortError(error)) return error as Error;
	if (error instanceof ToolError && what === undefined) return error;
	return new ToolError(what ?? errorMessage(error), error instanceof ToolError ? error.context : undefined);
}

/**
 * Render an error for LLM consumption.
 * Handles ToolError.render() and falls back to message/string.
 */
export function renderError(e: unknown): string {
	if (e instanceof ToolError) {
		return e.render();
	}
	if (e instanceof Error) {
		return e.message;
	}
	return String(e);
}
