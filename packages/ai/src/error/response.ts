/**
 * The transport stage, before anything is an error: what a RESPONSE states about a second attempt.
 *
 * `flags.ts` classifies a thrown value. This file answers the same question one step earlier, for a
 * non-2xx `Response` a provider ladder is holding, and it answers it through the same registry:
 * classify what the response says, then ask {@link recover} what the transport stage does about it.
 *
 * It exists because four ladders had written that decision out by hand, each with its own transient
 * vocabulary and its own idea of what a status means. `anthropic-client.ts` read the status set plus
 * 409; `ollama.ts` read 5xx and a body pattern; `usage/claude.ts` read the same set minus 429; and
 * `@veyyon/utils`' `fetchWithRetry` gate stood in front of all of them. Four spellings of one
 * question is four places for it to drift, and it had: a 429 was a wall to the credential layer and
 * a throttle to two of the ladders.
 *
 * THE BODY IS PART OF THE DECISION. "The peer answered 429" and "the peer answered 429 and said
 * `Too many requests`" are different failures — one is a spent allowance a sibling credential
 * answers, the other is a throttle a pause answers — and a ladder that reads only the number cannot
 * tell them apart. The body is read through {@link readProviderErrorBody}, the same bounded read the
 * error message uses, so a captive portal's HTML page cannot arrive here uncapped either.
 *
 * What a provider still states for itself is its {@link ResponseRetryPolicy}: a status its own API
 * documents as retryable, a status it refuses on principle, a body it knows a replay reproduces.
 * Those are facts about one provider. What a status MEANS is not, and it lives in the registry.
 */
import type { Api } from "../types";
import { readProviderErrorBody } from "./error-body";
import { create } from "./flag";
import { classifySignal, recover } from "./registry";
import { isTransientStatus } from "./retryable";

/** The header a provider uses to override the verdict for one response. */
const SHOULD_RETRY_HEADER = "x-should-retry";

/** What one provider states about its own responses, beyond what the registry reads off them. */
export interface ResponseRetryPolicy {
	/** The failing provider, for the rules that are gated on one. */
	api?: Api;
	/** Statuses this provider's API documents as retryable and the registry does not read as such. */
	alsoRetry?: readonly number[];
	/** Statuses this provider refuses however they read. */
	neverRetry?: readonly number[];
	/** A body whose failure this provider knows a replay reproduces. */
	refusesReplay?: (body: string) => boolean;
}

/**
 * Whether a failed response is worth another attempt, given its body if the caller has it.
 *
 * The order is deliberate. A provider's explicit `x-should-retry` is an instruction and wins over
 * every reading; a policy refusal is next, because a caller that knows a replay reproduces this body
 * knows more than the status does; then the registry speaks; and a status nothing recognised falls
 * back to the canonical transient set, which is the one case where the number is all there is.
 */
export function retryResponse(response: Response, body: string | undefined, policy: ResponseRetryPolicy = {}): boolean {
	const header = response.headers.get(SHOULD_RETRY_HEADER);
	if (header === "true") return true;
	if (header === "false") return false;
	const status = response.status;
	if (policy.neverRetry?.includes(status)) return false;
	if (body !== undefined && policy.refusesReplay?.(body)) return false;
	if (policy.alsoRetry?.includes(status)) return true;
	const kinds = classifySignal({
		text: body ?? "",
		status,
		api: policy.api,
		http2: undefined,
		code: undefined,
	});
	// A STATUS WITH NOTHING TO READ falls through to the transient set on purpose, the same way
	// `isProviderRetryableError` does: the registry leaves a bare 5xx unclassified because "the peer
	// answered 503" is not the claim "this is transient", and the ladder is the layer that decides to
	// try a bare number again.
	if (kinds === 0) return isTransientStatus(status);
	return recover(create(kinds), "transport").action === "retry";
}

/**
 * Read a failed response's body under the shared ceiling, then decide.
 *
 * The read is on a clone, so the caller still owns the original body for the error it raises. A body
 * that cannot be read at all decides on the status alone rather than failing the request twice.
 */
export async function retryResponseAfterReading(
	response: Response,
	policy: ResponseRetryPolicy = {},
): Promise<boolean> {
	let body: string | undefined;
	try {
		body = (await readProviderErrorBody(response.clone())).text;
	} catch {
		// A body that cannot even be cloned is a body nobody will read. The status is the diagnosis.
	}
	return retryResponse(response, body, policy);
}
