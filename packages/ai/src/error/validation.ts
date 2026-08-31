import { attach, create, Flag } from "./flags";

/**
 * Caller-supplied input failed validation before/while building a provider
 * request: bad request body, malformed tool arguments, unsupported content
 * type, a schema that cannot be normalized, an unknown tool, etc.
 *
 * This is a programmer/config/contract error, not a transient provider fault —
 * it is never retried.
 */
export class ValidationError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ValidationError";
	}
}

/**
 * A referenced tool was not found in the active tool set.
 *
 * THE READER IS THE MODEL. `Tool "grep_files" not found` states the failure and
 * leaves the only two next moves as guessing another name or abandoning the
 * task, and a name guessed from nothing is usually wrong twice. The active set
 * is the remedy: it is what the model needs and the caller already holds it.
 *
 * `availableNames` is optional so the historical one-argument construction keeps
 * working, and the list is bounded because a session can expose a hundred tools
 * and this text is re-read on every turn that holds it.
 */
export class ToolNotFoundError extends ValidationError {
	constructor(toolName: string, availableNames?: readonly string[]) {
		super(
			availableNames && availableNames.length > 0
				? `Tool "${toolName}" not found. Fix: call one of the tools that exist instead. Available: ${describeAvailableTools(availableNames)}.`
				: `Tool "${toolName}" not found. Fix: it is not in this session's active tool set, so calling it again with different arguments will fail the same way. Use a tool that is listed for you, or tell the operator which tool you need.`,
		);
		this.name = "ToolNotFoundError";
	}
}

/** Longest available-tool list echoed into a not-found message. */
const MAX_AVAILABLE_TOOLS_LISTED = 40;

function describeAvailableTools(names: readonly string[]): string {
	const sorted = [...names].sort();
	if (sorted.length <= MAX_AVAILABLE_TOOLS_LISTED) return sorted.join(", ");
	const shown = sorted.slice(0, MAX_AVAILABLE_TOOLS_LISTED).join(", ");
	return `${shown}, and ${sorted.length - MAX_AVAILABLE_TOOLS_LISTED} more`;
}

/**
 * Provider/auth configuration was missing or malformed (env var pointing at a
 * missing file, missing projectId, bad bind string, mTLS half-configured, …).
 */
export class ConfigurationError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ConfigurationError";
	}
}

/** A request was abandoned because it exceeded a stream/idle/first-event deadline. */
export class StreamTimeoutError extends Error {
	constructor(
		message = "Request timed out. Fix: this is a transient provider or network failure, so one retry is worth attempting. If it keeps happening, check network reachability to the provider and any proxy in front of it.",
		options?: { cause?: unknown },
	) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "StreamTimeoutError";
		attach(this, create(Flag.Transient, Flag.Timeout));
	}
}
