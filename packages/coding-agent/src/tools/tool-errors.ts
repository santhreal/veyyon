import { isAbortError } from "@veyyon/utils/abortable";
import { errorMessage } from "@veyyon/utils/type-guards";

export class ToolError extends Error {
	constructor(
		message: string,
		readonly context?: Record<string, unknown>,
	) {
		super(message);
		this.name = "ToolError";
	}

	render(): string {
		return this.message;
	}
}

export class ToolAbortError extends Error {
	static readonly MESSAGE = "Operation aborted";

	constructor(message: string = ToolAbortError.MESSAGE, options?: ErrorOptions) {
		super(message, options);
		this.name = "ToolAbortError";
	}
}

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

export function throwIfAborted(signal?: AbortSignal, what?: string): void {
	if (!signal?.aborted) return;
	throw toolAbort(signal.reason, what);
}

export function toolAbort(reason: unknown, what?: string): ToolAbortError {
	if (reason instanceof ToolAbortError) return reason;
	return new ToolAbortError(abortMessage(reason, what), { cause: reason });
}

export function toolFailure(error: unknown, what?: string): Error {
	if (isAbortError(error)) return error as Error;
	if (error instanceof ToolError && what === undefined) return error;
	return new ToolError(what ?? errorMessage(error), error instanceof ToolError ? error.context : undefined);
}

export function renderError(e: unknown): string {
	if (e instanceof ToolError) {
		return e.render();
	}
	return errorMessage(e);
}
