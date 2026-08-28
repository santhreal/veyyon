/** Standardized error types for tool execution. Tools should throw these instead of returning error text. */
// Subpath imports, not the `@veyyon/utils` barrel: the barrel loads dotenv at import time, and this
// module is reachable from `eval/js/process-entry`, which must not read a `.env` before profile
// bootstrap (pinned by `eval/__tests__/process-entry-import.test.ts`).
import { isAbortError } from "@veyyon/utils/abortable";
import { errorMessage } from "@veyyon/utils/type-guards";

/** Base error for tool execution failures. Override render() for custom LLM-facing formatting. */
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

/** The sentence to show for an abort, given whatever the signal was aborted with. `AbortSignal.reason` is `any`: a string from `controller.abort("deadline")`, a */
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

/** Throw {@link ToolAbortError} when `signal` has already been aborted. Use this rather than `signal.throwIfAborted()`. The platform method throws */
export function throwIfAborted(signal?: AbortSignal, what?: string): void {
	if (!signal?.aborted) return;
	throw toolAbort(signal.reason, what);
}

/** The {@link ToolAbortError} to throw for `reason`, preserving what it said. {@link throwIfAborted} covers the common case where the reason lives on a */
export function toolAbort(reason: unknown, what?: string): ToolAbortError {
	if (reason instanceof ToolAbortError) return reason;
	return new ToolAbortError(abortMessage(reason, what), { cause: reason });
}

/** The error to throw for a tool failure, WITHOUT flattening a cancellation into one. */
export function toolFailure(error: unknown, what?: string): Error {
	if (isAbortError(error)) return error as Error;
	if (error instanceof ToolError && what === undefined) return error;
	return new ToolError(what ?? errorMessage(error), error instanceof ToolError ? error.context : undefined);
}

/** Render an error for LLM consumption. Handles ToolError.render() and falls back to message/string. */
export function renderError(e: unknown): string {
	if (e instanceof ToolError) {
		return e.render();
	}
	return errorMessage(e);
}
