import { attach, create, Flag } from "./flags";

/**
 * A provider request was cancelled — by the caller's `AbortSignal` or a
 * provider-local watchdog. Carries the {@link Flag.Abort} classification
 * structurally so retry logic does not have to regex the message text.
 *
 * Named for the layer it comes from. Three unrelated classes in this workspace
 * used to be called `AbortError`: this one, the signal-shaped `AbortError` in
 * `@veyyon/utils`, and a killed child process (`ProcessAbortError`, also in
 * `@veyyon/utils`). One name for three classes makes an `instanceof` check read
 * as a question about cancellation when it is really a question about which
 * layer raised it, and that check compiles and passes while asking the wrong
 * thing.
 *
 * `name` stays `"AbortError"` and the default message stays byte-identical to
 * the historical `"Request was aborted"` string: `isAbortError` reads the name,
 * the auth gateway classifies a 499 from it, and text-based matchers remain in
 * the field.
 */
export class RequestAbortError extends Error {
	constructor(message = "Request was aborted", options?: { cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "AbortError";
		attach(this, create(Flag.Abort));
	}
}
