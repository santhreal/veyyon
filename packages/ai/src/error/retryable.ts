import { isRetryableStatus } from "@veyyon/utils/fetch-retry";
import { classify, Flag, is, recover, status, vetoesRetry } from "./flags";

/**
 * Whether a numeric HTTP status is in the canonical transient set (408, 429, 5xx).
 */
export function isTransientStatus(status: number | undefined): boolean {
	return status !== undefined && isRetryableStatus(status);
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
 * ONE DECISION, READ FROM THE REGISTRY. A provider ladder is the transport stage of the same
 * recovery every other layer performs, so it asks the registry what that stage does about this
 * failure and does not decide anything itself. Every family states its own answer: `transport` and
 * `timeout` retry, `quota` rotates a credential, `stream` and `tool-call` re-send the turn one level
 * up, `refusal`, `content` and `interrupt` refuse outright. Before this, the function was a list of
 * conditions that re-derived those answers from message prose, and each one it re-derived it
 * disagreed with: an account-level cap needed a hand-written veto, a fast-mode entitlement wall was
 * retried through the words "rate_limit_error", and a truncated stream was retried here while
 * reaching the turn as an unclassified failure because these words lived nowhere else. They now live
 * in the transport family, next to the rest of the transport vocabulary.
 *
 * A 4xx IS A WALL AT THIS STAGE, and that is a fact about the stage rather than about the failure: a
 * provider ladder is a seconds-scale backoff against the same credential and the same request, and
 * nothing it can wait for changes a 400. Only 408 and 429 are timing answers. The one exception is a
 * 400 whose meaning a single provider knows — Copilot's routing flap — which arrives through
 * {@link ProviderRetryableHooks} rather than as a rule everybody else's 400 also matches.
 *
 * A STATUS WITH NOTHING TO READ is the last question, and only when the registry recognised nothing:
 * `classify` returns the bare number as the id when a failure carries a status and no wording its
 * rules read, which is deliberate — an id that is only a status says so — so the transient set
 * answers for it. `error/response.ts` asks the same two questions in the same order about a failed
 * response, which is the point: one shape for one decision, whether it arrived as a throw or a 503.
 */
export function isProviderRetryableError(error: unknown, hooks: ProviderRetryableHooks = {}): boolean {
	if (!(error instanceof Error)) return false;
	const id = classify(error);
	// The veto is read before anything else because everything else reads the OUTERMOST message, and a
	// provider is free to compose a transient-sounding sentence around the cause it wrapped:
	// `NGHTTP2_CANCEL: operation timed out`, a content filter whose body carried a 503, a cancellation
	// whose own sentence says "aborted", an undelimited frame inside a wrapper that says "please
	// retry".
	if (vetoesRetry(id)) return false;
	if (hooks.isProviderTransient?.(error)) return true;
	const httpStatus = status(error);
	if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && !isTransientStatus(httpStatus)) {
		return false;
	}
	if (!is(id, Flag.Class)) return isTransientStatus(httpStatus);
	return recover(id, "transport").action === "retry";
}
