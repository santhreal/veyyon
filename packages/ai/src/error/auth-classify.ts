import { extractHttpStatusFromError } from "@veyyon/utils/fetch-retry";
import { isUsageLimit } from "./flags";
import { isUsageLimitOutcome } from "./rate-limit";

/**
 * Whether an upstream failure should rotate to a sibling credential: a hard
 * `401`, a body-classified usage limit (Codex `usage_limit_reached`, Anthropic
 * account rate-limit, Google `resource_exhausted`, OpenAI `insufficient_quota`,
 * …), or a bare `429` whose payload did not preserve a richer quota code.
 * Transient 429s (`Too many requests`, per-minute caps) stay in the
 * upstream-backoff lane.
 */
export function isAuthRetryableError(error: unknown): boolean {
	if (isUsageLimit(error)) return true;
	const httpStatus = extractHttpStatusFromError(error);
	if (httpStatus === 401) return true;
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	const embeddedStatus = message ? extractHttpStatusFromError({ message }) : undefined;
	if (embeddedStatus === 401) return true;
	return isUsageLimitOutcome(httpStatus ?? embeddedStatus, message);
}
