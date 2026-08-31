import { errorMessage } from "@veyyon/utils/type-guards";
import type { Api } from "../types";
import type { AbortSourceTracker } from "../utils/abort";
import type { CapturedHttpErrorResponse, RawHttpRequestDump } from "../utils/http-inspector";
import { classify, classifyMessage, status } from "./flags";
import { formatMessage } from "./format";

/** Context a provider catch block hands to {@link finalize}. */
export interface FinalizeOptions {
	/** Wire API, for api-specific text classification (e.g. stale-responses items). */
	api?: Api;
	/** Provider id; forwarded to the message formatter for copilot rewrites. */
	provider?: string;
	/** Caller signal, for providers that don't run an abort tracker. */
	signal?: AbortSignal;
	/** Abort tracker, preferred over `signal`: distinguishes caller vs. local aborts. */
	abortTracker?: AbortSourceTracker;
	/** Raw request, dumped into the message for 400-class failures. */
	rawRequestDump?: RawHttpRequestDump;
	/** Captured non-2xx response body, used for status fallback and message detail. */
	capturedErrorResponse?: CapturedHttpErrorResponse;
}

/** The full bundle a provider assigns onto its `AssistantMessage` error fields. */
export interface FinalizeResult {
	/** Structured flag id from {@link classify}. */
	id: number;
	/** HTTP status, from the error or the captured response. */
	status: number | undefined;
	/** `"aborted"` when the caller cancelled, otherwise `"error"`. */
	stopReason: "aborted" | "error";
	/**
	 * How loud a provider's own record of this outcome should be.
	 *
	 * A caller abort is not a failure. Pressing stop is the one outcome that was
	 * asked for, and grading it `error` files a red record for it: four of
	 * twenty-two recorded terminal Devin stream failures were cancellations
	 * logged at `error`, which is noise sitting on top of the eighteen that were
	 * real. The level is derived from the same `aborted` fact `stopReason` comes
	 * from, so a record can never say "aborted" at `error` or the reverse.
	 */
	logLevel: "debug" | "error";
	/**
	 * The classification rules that decided this id, in registry order.
	 *
	 * A record that states only the outcome leaves "which rule said so" to be re-derived by hand
	 * against the provider's sentence, which is what a misclassification costs to diagnose. The names
	 * come from the same walk that produced `id`, so a record can never name a rule that did not fire.
	 */
	rules: readonly string[];
	/** User-facing message from {@link formatMessage}, or a local abort reason. */
	message: string;
}

/**
 * Build the complete error bundle for a provider catch block, replacing the
 * `stopReason` / `errorStatus` / `errorId` / `errorMessage` boilerplate.
 *
 * `stopReason` comes from the abort tracker (caller intent dominates) or, when
 * no tracker is supplied, the raw `signal.aborted`. A local abort reason (e.g. a
 * first-event timeout) supersedes the formatted message. Message formatting is
 * wrapped so a formatter throw can never skip the caller's `stream.end()`.
 */
export async function finalize(error: unknown, opts: FinalizeOptions = {}): Promise<FinalizeResult> {
	const aborted = opts.abortTracker ? opts.abortTracker.wasCallerAbort() : opts.signal?.aborted === true;
	const currentStatus = status(error) ?? opts.capturedErrorResponse?.status;

	let message: string;
	try {
		const localReason = opts.abortTracker?.getLocalAbortReason();
		message = localReason?.message ?? (await formatMessage(error, opts));
	} catch {
		message = errorMessage(error);
	}

	const trace: string[] = [];
	const id = classifyMessage(
		{
			api: opts.api,
			errorId: classify(error, opts.api, trace),
			errorMessage: message,
			errorStatus: currentStatus,
		},
		trace,
	);

	return {
		id,
		status: currentStatus,
		stopReason: aborted ? "aborted" : "error",
		logLevel: aborted ? "debug" : "error",
		rules: [...new Set(trace)],
		message,
	};
}
