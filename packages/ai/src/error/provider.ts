import { ProviderHttpError } from "./classes";
import { attach, create, Flag } from "./flags";

/** Which part of a provider exchange produced a non-HTTP error. */
export type ProviderResponseErrorKind =
	/** Stream closed before a terminal completion/response event. */
	| "incomplete-stream"
	/** Terminal event carried an error / unexpected stop reason. */
	| "output"
	/** Response body was empty/missing when content was required. */
	| "empty-body"
	/** Malformed wire envelope (unexpected message ordering / shape). */
	| "envelope"
	/** Content was blocked by a provider safety filter. */
	| "content-blocked"
	/** Runtime/namespace resolution or other provider-internal failure. */
	| "runtime";

export interface ProviderResponseErrorOptions {
	provider?: string;
	kind?: ProviderResponseErrorKind;
	cause?: unknown;
}

/**
 * Table mapping non-HTTP provider failure kinds to retryability verdicts.
 */
export const PROVIDER_RESPONSE_RETRYABLE: Record<ProviderResponseErrorKind, boolean> = {
	"incomplete-stream": true,
	"empty-body": true,
	envelope: false,
	output: false,
	"content-blocked": false,
	runtime: false,
};

/**
 * Standard error messages for terminal finish reasons.
 */
export function providerFinishErrorMessage(reason: string | undefined): string {
	return `Provider finish_reason: ${reason || "unknown"}`;
}

/**
 * Matches the message {@link providerFinishErrorMessage} mints, and the three
 * legacy phrasings that reached persisted sessions before it existed. A resumed
 * transcript replays the wording of the version that wrote it, so dropping the
 * legacy alternatives would reclassify history.
 */
export const PROVIDER_FINISH_ERROR_PATTERN =
	/\bProvider (?:returned error finish_reason|finish_reason:\s*error)\b|\bGeneration failed with (?:stop|finish) reason:\s*error\b/i;

/**
 * A non-HTTP provider failure: a truncated stream, an error stop reason, an
 * empty body, a malformed envelope, or a runtime fault. For non-2xx HTTP
 * responses use {@link ProviderHttpError} (or a provider subclass) instead.
 */
export class ProviderResponseError extends Error {
	readonly provider: string | undefined;
	readonly kind: ProviderResponseErrorKind;

	constructor(message: string, options: ProviderResponseErrorOptions = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ProviderResponseError";
		this.provider = options.provider;
		this.kind = options.kind ?? "output";
		// A safety filter block is terminal and intentionally non-retryable.
		if (this.kind === "content-blocked") attach(this, create(Flag.ContentBlocked));
		else if (PROVIDER_RESPONSE_RETRYABLE[this.kind]) attach(this, create(Flag.Transient));
	}
}

/** Non-2xx response from the Devin API. */
export class DevinApiError extends ProviderHttpError {
	override readonly name = "DevinApiError";
}

/** Non-2xx response, or a Connect/gRPC stream trailer failure, from the Cursor API. */
export class CursorApiError extends ProviderHttpError {
	override readonly name = "CursorApiError";
}

/** Non-2xx response from the GitLab Duo direct-access API. */
export class GitLabDuoApiError extends ProviderHttpError {
	override readonly name = "GitLabDuoApiError";
}

/** Non-2xx response from the GitLab Duo Workflow API. */
export class GitLabDuoWorkflowApiError extends ProviderHttpError {
	override readonly name = "GitLabDuoWorkflowApiError";
}
