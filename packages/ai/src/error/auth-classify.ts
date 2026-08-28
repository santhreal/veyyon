import { extractHttpStatusFromError } from "@veyyon/utils/fetch-retry";
import { isUsageLimit } from "./flags";

/**
 * Whether an upstream failure should rotate to a sibling credential: the account's allowance is
 * spent (Codex `usage_limit_reached`, Anthropic account rate-limit, Google `resource_exhausted`,
 * OpenAI `insufficient_quota`, a bare `429`), or the credential was refused outright with a `401`.
 *
 * A `403` is deliberately NOT rotation on its own. It is a refused credential and the registry's
 * auth family answers it with `reauth`, which is a different act: a sibling key has no more
 * permission than this one, and rotating on every `403` walks a whole pool for one misconfigured
 * account. A `403` that says the account is out of credits (xAI SuperGrok) rotates through the quota
 * question instead, on its wording rather than its status.
 *
 * Transient 429s (`Too many requests`, per-minute caps) stay in the upstream-backoff lane.
 *
 * A LOCAL FAILURE MAY OPT OUT. Both tests below read prose, so an error raised on this side of the
 * wire whose text happens to quote a status would rotate the operator's credential over a decision
 * nothing upstream made. `pi-native`'s payload hook is the case: a caller's sanitizer rejecting a
 * request is local policy, and it used to buy its safety by discarding the rejection's message
 * entirely, which left the operator with a seam name and no reason. An error setting
 * {@link AUTH_EVIDENCE_LOCAL} states that its text is its own, so it can say what went wrong.
 */
export function isAuthRetryableError(error: unknown): boolean {
	if (isLocalEvidence(error)) return false;
	if (isUsageLimit(error)) return true;
	if (extractHttpStatusFromError(error) === 401) return true;
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	return message !== undefined && extractHttpStatusFromError({ message }) === 401;
}

/**
 * Set on an error whose message describes a decision made here, not a response received from
 * upstream. Read by {@link isAuthRetryableError}; a `true` value is the only one that opts out.
 */
export const AUTH_EVIDENCE_LOCAL = "authEvidenceIsLocal";

function isLocalEvidence(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const marked = error as { [AUTH_EVIDENCE_LOCAL]?: unknown };
	return marked[AUTH_EVIDENCE_LOCAL] === true;
}
