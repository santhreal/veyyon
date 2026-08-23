import { isRetryableStatus, isUnexpectedSocketCloseMessage } from "@veyyon/utils/fetch-retry";
import { isStreamFrameLimitError } from "@veyyon/utils/stream-frame-limit";
import {
	classify,
	Flag,
	is,
	isRetryableStreamEnvelopeError,
	isTransientStreamParseError,
	isUsageLimit,
	status,
	TRANSIENT_TRANSPORT_PATTERN,
	vetoesRetry,
} from "./flags";

/**
 * Whether a numeric HTTP status is in the canonical transient set: 408, 429, and any 5xx.
 *
 * The set itself belongs to `@veyyon/utils`' `isRetryableStatus`, because a status is a fact about a
 * transport and `utils` cannot import `ai`. This wrapper adds the one thing this layer needs — a
 * status that may be absent — and nothing else. It used to restate the three comparisons, which is
 * how two copies of one vocabulary end up disagreeing by a number.
 *
 * Distinct from {@link classify}, which reads a whole failure including its wording and may say more.
 * Use this when a status is all there is.
 */
export function isTransientStatus(status: number | undefined): boolean {
	return status !== undefined && isRetryableStatus(status);
}

// Provider-stream transient phrasings not covered by the shared
// TRANSIENT_TRANSPORT_PATTERN (TLS record corruption, HTTP/2 peer stream
// errors, upstream code 1302). The shared pattern already covers rate-limit /
// overloaded / 5xx / timeout / first-event wording.
const PROVIDER_TRANSIENT_EXTRA_PATTERN = /bad record mac|stream error.*received from peer|1302/i;

function isTransientTransportMessage(message: string): boolean {
	return message.includes("tls: bad record mac") || message.includes("type=server_error");
}

/** Hook for provider-specific transient detection that the error module must not import directly. */
export interface ProviderRetryableHooks {
	/** Provider id of the failing request, used to gate provider-specific checks. */
	provider?: string;
	/** Provider-specific transient predicate (e.g. Copilot `model_not_supported`). */
	isProviderTransient?: (error: Error) => boolean;
}

/**
 * Whether a provider stream error should be retried against the same credential.
 *
 * Account-level usage/quota limits are deliberately treated as **non**-retryable
 * here (they are owned by the credential-rotation layer: auth-gateway /
 * `streamSimple` a/b/c policy), not this seconds-scale provider backoff.
 *
 * THE CLASSIFIER OWNS TRANSIENCE. An error that declares itself transient, either
 * structurally ({@link ProviderResponseError} with an `incomplete-stream` or
 * `empty-body` kind, an Anthropic connection fault, a stream timeout) or through
 * {@link classify}'s text and status rules, is retried here. It used to be
 * re-derived from message prose in this function alone, which is a second opinion
 * and it disagreed: a Devin empty body carried `Flag.Transient` and the turn loop
 * retried it while this predicate refused, and a truncated Cursor stream was
 * retried only because its sentence happened to contain the word "truncated".
 * The text patterns below stay, because they cover transport phrasings the
 * classifier does not (TLS record corruption, HTTP/2 peer stream errors, upstream
 * 1302, mid-JSON truncation, out-of-order stream events).
 *
 * THE REGISTRY OWNS REFUSAL. A family that declares `vetoesRetry` refuses a retry
 * for the whole failure, and this predicate reads that mask instead of holding a
 * second opinion about it: a cancellation gets the same answer here as
 * {@link retriable} gives at the turn, so pressing escape mid-stream ends the
 * stream instead of re-entering it.
 *
 * Provider-specific transient cases are injected via {@link ProviderRetryableHooks}
 * so this stays free of provider imports.
 */
export function isProviderRetryableError(error: unknown, hooks: ProviderRetryableHooks = {}): boolean {
	if (!(error instanceof Error)) return false;
	// A peer that never delimited its frame will not delimit it on the second attempt, so
	// a retry is a second helping of the same exhaustion attempt. First, ahead of the
	// provider hook and the prose rules: those read the OUTERMOST message, which a
	// provider is free to compose around the cause it wrapped.
	if (isStreamFrameLimitError(error)) return false;
	const id = classify(error);
	// THE REGISTRY REFUSES, and this reads its answer rather than restating any part of it. A family
	// that declares `vetoesRetry` refuses a retry for the whole failure however the rest of it
	// classified, and three do: a named HTTP/2 code the RFC says a replay reproduces, a content
	// filter's verdict on the request, and a cancellation. All three had to be read before the prose
	// rules below, because those read the OUTERMOST message and a provider is free to compose a
	// sentence around the cause it wrapped — `NGHTTP2_CANCEL: operation timed out` came back
	// retryable through the words "timed out", a filter whose body also carried a 503 through the
	// transport wording, and a cancellation through the word "aborted" in its own message while
	// `retriable()` refused the identical failure at the turn. The flags sit BESIDE `Flag.Transient`
	// rather than clearing it, so each failure still describes itself the way it arrived and only
	// the decision changes. The HTTP/2 case was a hand-written second copy of one bit of this mask.
	if (vetoesRetry(id)) return false;
	if (hooks.isProviderTransient?.(error)) return true;
	if (isUsageLimit(error)) return false;
	const httpStatus = status(error);
	if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 && httpStatus !== 429) {
		return false;
	}
	if (is(id, Flag.Transient)) return true;
	const msg = error.message.toLowerCase();
	if (
		isUnexpectedSocketCloseMessage(msg) ||
		isTransientTransportMessage(msg) ||
		TRANSIENT_TRANSPORT_PATTERN.test(msg) ||
		PROVIDER_TRANSIENT_EXTRA_PATTERN.test(msg) ||
		isTransientStreamParseError(error) ||
		isRetryableStreamEnvelopeError(error)
	) {
		return true;
	}
	// A STATUS WITH NOTHING TO READ. `classify` returns the bare number as the id when a failure
	// carries a status and no message its rules recognise, which is deliberate — an id that is only a
	// status says so — and it means `Flag.Transient` is absent even for a 503. The transient set is
	// the same one `isTransientStatus` states, so it is read here rather than re-derived: this used to
	// be answered by `@veyyon/utils/fetch-retry`'s `isRetryableError`, a second classifier with a
	// second transient vocabulary, and the two disagreed by exactly one phrase.
	if (isTransientStatus(httpStatus)) return true;
	return false;
}
