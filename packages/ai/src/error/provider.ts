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
 * Whether each non-HTTP provider failure is worth another attempt.
 *
 * ONE TABLE, AND IT IS EXHAUSTIVE BY TYPE. The retry verdict used to live in an
 * `if` chain here and be re-derived from message prose by
 * {@link isProviderRetryableError}, so the two deciders disagreed: a Devin empty
 * body was retried by the turn loop and refused by the provider loop, and a
 * truncated Cursor stream was retried only because its message happened to
 * contain the word "truncated". A `Record` keyed on the union means a new kind
 * cannot be added without recording a verdict for it: the type check fails
 * instead of the new kind silently inheriting "do not retry".
 *
 * An incomplete stream or an empty body never produced any content, so the
 * request did not complete and a retry is safe (the retry layer's replay-unsafe
 * guard still blocks one when partial tool output already escaped). A safety
 * filter block, a malformed envelope, an error stop reason and a provider
 * runtime fault all reproduce on replay, so they are terminal.
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
