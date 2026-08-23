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
 */
export function isAuthRetryableError(error: unknown): boolean {
	if (isUsageLimit(error)) return true;
	if (extractHttpStatusFromError(error) === 401) return true;
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	return message !== undefined && extractHttpStatusFromError({ message }) === 401;
}
