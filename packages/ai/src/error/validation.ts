import { attach, create, Flag } from "./flags";

export class ValidationError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ValidationError";
	}
}

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

const MAX_AVAILABLE_TOOLS_LISTED = 40;

function describeAvailableTools(names: readonly string[]): string {
	const sorted = names.slice().sort();
	if (sorted.length <= MAX_AVAILABLE_TOOLS_LISTED) return sorted.join(", ");
	const shown = sorted.slice(0, MAX_AVAILABLE_TOOLS_LISTED).join(", ");
	return `${shown}, and ${sorted.length - MAX_AVAILABLE_TOOLS_LISTED} more`;
}

export class ConfigurationError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ConfigurationError";
	}
}

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
