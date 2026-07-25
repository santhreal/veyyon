/**
 * Standardized error types for tool execution.
 *
 * Tools should throw these instead of returning error text.
 * The agent loop catches and renders them appropriately.
 */

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
	const { reason } = signal;
	if (reason instanceof ToolAbortError) throw reason;
	throw new ToolAbortError(abortMessage(reason, what), { cause: reason });
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
