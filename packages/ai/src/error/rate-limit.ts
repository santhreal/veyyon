/**
 * Rate limit reason classification and backoff calculation utilities.
 * Ported from opencode-antigravity-auth plugin for consistency.
 */

export type RateLimitReason =
	| "QUOTA_EXHAUSTED"
	| "RATE_LIMIT_EXCEEDED"
	| "MODEL_CAPACITY_EXHAUSTED"
	| "SERVER_ERROR"
	| "UNKNOWN";

const QUOTA_EXHAUSTED_BACKOFF_MS = 30 * 60 * 1000; // 30 min
const RATE_LIMIT_EXCEEDED_BACKOFF_MS = 30 * 1000; // 30s
const MODEL_CAPACITY_BASE_MS = 45 * 1000; // 45s base
const MODEL_CAPACITY_JITTER_MS = 30 * 1000; // ±15s
const SERVER_ERROR_BACKOFF_MS = 20 * 1000; // 20s

const ACCOUNT_RATE_LIMIT_PATTERN =
	/\baccount(?:'s)?\b[^\n]{0,80}\brate.?limit\b|\brate.?limit\b[^\n]{0,80}\baccount\b/i;
const INSUFFICIENT_BALANCE_PATTERN = /insufficient.?balance/i;
// A status code named in prose is a whole number. `lower.includes("503")` also
// fired inside `5030 credits remaining` and inside a request id, which routed an
// exhausted balance to a 45-second capacity backoff instead of rotating the
// credential. Digit boundaries, not substrings. A bare `500ms` latency figure
// still reads as a status, which no report has produced and which a unit suffix
// would have to be enumerated to exclude.
const CAPACITY_STATUS_PATTERN = /(?<!\d)(?:503|529)(?!\d)/;
// 502 and 504 are the same claim 500 makes — an upstream broke or timed out, and the next attempt
// reaches a peer that may not have. They were missing, so a bare `HTTP 502 Bad Gateway` matched no
// branch, returned UNKNOWN, and the fallback selector was suppressed for five minutes over a
// gateway blip that a twenty-second wait clears. Same digit-boundary guard as above: `5040` is a
// token count, not a status.
const SERVER_ERROR_STATUS_PATTERN = /(?<!\d)(?:500|502|504)(?!\d)/;

/**
 * Classify a rate-limit error message into a reason category.
 * Priority order: QUOTA (Antigravity "quota will reset") > MODEL_CAPACITY > QUOTA (account) >
 * RATE_LIMIT > QUOTA (generic) > SERVER_ERROR > UNKNOWN.
 *
 * "resource exhausted" maps to MODEL_CAPACITY (transient, short wait)
 * "quota exceeded" / "quota will reset" maps to QUOTA_EXHAUSTED (long wait, switch account)
 */
export function parseRateLimitReason(errorMessage: string): RateLimitReason {
	const lower = errorMessage.toLowerCase();

	// Antigravity / Cloud Code Assist surface multi-hour daily-quota exhaustion as
	// "You have exhausted your capacity on this model. Your quota will reset after …".
	// The literal "capacity" used to pre-empt the QUOTA branch even though "quota
	// will reset" is the long-wait signal — short-circuit here before the
	// MODEL_CAPACITY fallthrough so credential rotation (not 60s backoff) kicks in.
	if (lower.includes("quota will reset") || lower.includes("exhausted your capacity")) {
		return "QUOTA_EXHAUSTED";
	}

	if (
		lower.includes("capacity") ||
		lower.includes("overloaded") ||
		CAPACITY_STATUS_PATTERN.test(lower) ||
		lower.includes("resource exhausted")
	) {
		return "MODEL_CAPACITY_EXHAUSTED";
	}

	if (ACCOUNT_RATE_LIMIT_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (
		lower.includes("per minute") ||
		lower.includes("rate limit") ||
		lower.includes("too many requests") ||
		lower.includes("presque")
	) {
		return "RATE_LIMIT_EXCEEDED";
	}

	if (
		lower.includes("exhausted") ||
		lower.includes("quota") ||
		lower.includes("usage limit") ||
		// xAI SuperGrok: HTTP 403 "run out of credits" / spending-limit is an
		// account-local cap — rotate, don't treat as auth failure.
		lower.includes("run out of credits") ||
		lower.includes("out of credits") ||
		lower.includes("spending-limit") ||
		lower.includes("spending limit") ||
		INSUFFICIENT_BALANCE_PATTERN.test(errorMessage)
	) {
		return "QUOTA_EXHAUSTED";
	}

	if (
		SERVER_ERROR_STATUS_PATTERN.test(lower) ||
		lower.includes("internal error") ||
		lower.includes("internal server error")
	) {
		return "SERVER_ERROR";
	}

	return "UNKNOWN";
}

/**
 * Calculate backoff delay in ms for a given rate limit reason.
 * MODEL_CAPACITY gets jitter to prevent thundering herd.
 */
export function calculateRateLimitBackoffMs(reason: RateLimitReason): number {
	switch (reason) {
		case "QUOTA_EXHAUSTED":
			return QUOTA_EXHAUSTED_BACKOFF_MS;
		case "RATE_LIMIT_EXCEEDED":
			return RATE_LIMIT_EXCEEDED_BACKOFF_MS;
		case "MODEL_CAPACITY_EXHAUSTED":
			return MODEL_CAPACITY_BASE_MS + Math.random() * MODEL_CAPACITY_JITTER_MS;
		case "SERVER_ERROR":
			return SERVER_ERROR_BACKOFF_MS;
		default:
			return QUOTA_EXHAUSTED_BACKOFF_MS; // conservative default
	}
}

/** Detect usage/quota limit errors in error messages (persistent, requires credential switch). */
const USAGE_LIMIT_PATTERN =
	/usage.?limit|usage_limit_reached|usage_not_included|limit_reached|quota.?(?:exceeded|reached|insufficient)|额度不足|额度耗尽|resource.?exhausted|exhausted your capacity|quota will reset|insufficient.?(?:balance|quota)|run out of credits|out of credits|spending[- _]?limit|personal-team-blocked/i;

// `isUsageLimitStatus` and `isUsageLimitOutcome` are gone. They were the quota decision tree written
// a second time, outside the registry: `isUsageLimit(error) || isUsageLimitOutcome(status, message)`
// appeared at six call sites, because each half missed a case the other caught. The rules now live
// once, in the `quota` family in `domains/account.ts`, and the question has one accessor,
// `isUsageLimit` in `flags.ts`. The parts that family reads — `matchesUsageLimitText`,
// `isOpaqueStatusBody`, `parseRateLimitReason` — stay here.

/**
 * A 429 body is opaque when it carries no signal beyond the status itself —
 * empty, whitespace-only, the status digits with HTTP/JSON framing, or
 * generic punctuation. Anything else (retry hints, capacity wording, error
 * descriptions) is informative enough to defer to the classifier.
 */
export function isOpaqueStatusBody(message: string): boolean {
	const cleaned = message
		.replace(/\b429\b/g, "")
		.replace(/\b(?:http|https|status|error|code|response|message)\b/gi, "");
	return !/[a-z\d]{3,}/i.test(cleaned);
}

/**
 * Internal text matcher for usage/quota-limit phrasing. NOT part of the public
 * API — callers classify through {@link import("./flags").isUsageLimit} (the
 * flag accessor). `flags.ts` consumes this to populate `Flag.UsageLimit`, and
 * {@link isUsageLimitOutcome} uses it for the account-rotation decision.
 */
export function matchesUsageLimitText(errorMessage: string): boolean {
	return USAGE_LIMIT_PATTERN.test(errorMessage) || ACCOUNT_RATE_LIMIT_PATTERN.test(errorMessage);
}
