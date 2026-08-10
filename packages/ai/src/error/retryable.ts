import { isRetryableError, isUnexpectedSocketCloseMessage } from "@veyyon/utils/fetch-retry";
import {
	classify,
	Flag,
	is,
	isRetryableStreamEnvelopeError,
	isTransientStreamParseError,
	isUsageLimit,
	status,
	TRANSIENT_TRANSPORT_PATTERN,
} from "./flags";

/**
 * Whether a numeric HTTP status is in the canonical transient/retryable set:
 * 408 (Request Timeout), 429 (Too Many Requests), and any 5xx.
 *
 * This is a pure predicate over a status code already in hand — distinct from
 * {@link classify}, which inspects a whole error (including message text) and
 * may match more. Use this when you only have a `status: number`.
 */
export function isTransientStatus(status: number | undefined): boolean {
	return status !== undefined && (status === 408 || status === 429 || status >= 500);
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
 * Provider-specific transient cases are injected via {@link ProviderRetryableHooks}
 * so this stays free of provider imports.
 */
export function isProviderRetryableError(error: unknown, hooks: ProviderRetryableHooks = {}): boolean {
	if (!(error instanceof Error)) return false;
	if (hooks.isProviderTransient?.(error)) return true;
	if (isUsageLimit(error)) return false;
	const httpStatus = status(error);
	if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 && httpStatus !== 429) {
		return false;
	}
	if (is(classify(error), Flag.Transient)) return true;
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
	return isRetryableError(error);
}
