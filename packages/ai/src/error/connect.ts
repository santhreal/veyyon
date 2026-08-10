/**
 * Connect / gRPC stream-trailer failures, mapped onto the statuses the shared
 * classifier already understands.
 *
 * WHY THIS IS SHARED, AND WHY IT IS A TABLE. Devin (Cascade) and Cursor both
 * speak Connect over HTTP/2, so both report a failed stream the same way: a
 * trailer carrying a code and a sentence. Devin's half of that was fixed after
 * 564 of 2690 recorded turns (21%) died on a retryable trailer wrapped in a
 * `ValidationError`, and 561 of those were one rate-limit message the server
 * itself asked to have retried. Cursor's identical trailer still classified as
 * nothing at all, so `unavailable` from Cursor failed a turn outright while the
 * same code from Devin was retried and recovered. Two providers reading one
 * table is the only thing that stops them drifting apart again.
 *
 * The mapping is deliberately to HTTP statuses rather than to a private
 * verdict: `status(error)` plus the message is what {@link
 * isProviderRetryableError} and {@link classify} read, so a rate limit has to
 * arrive as 429, an authentication failure as 401 and a server fault as 503 to
 * be treated the way every other provider's equivalent already is.
 */

/** A stream-level failure read out of a Connect end-stream trailer. */
export interface ConnectTrailerFailure {
	/** Connect error code (`unavailable`, `resource_exhausted`, ...) or a numeric gRPC status. */
	readonly code: string;
	/** The server's human-readable message, which is what carries a rate-limit window. */
	readonly message: string;
}

/**
 * Canonical gRPC numeric statuses, because the two wire formats spell the same
 * failure differently: a Connect end-stream JSON trailer carries the code by
 * name, while an HTTP/2 `grpc-status` trailer carries the number. Normalizing
 * to the name means the code table below is written once.
 */
const GRPC_STATUS_NAMES: ReadonlyMap<string, string> = new Map([
	["1", "canceled"],
	["2", "unknown"],
	["3", "invalid_argument"],
	["4", "deadline_exceeded"],
	["5", "not_found"],
	["6", "already_exists"],
	["7", "permission_denied"],
	["8", "resource_exhausted"],
	["9", "failed_precondition"],
	["10", "aborted"],
	["11", "out_of_range"],
	["12", "unimplemented"],
	["13", "internal"],
	["14", "unavailable"],
	["15", "data_loss"],
	["16", "unauthenticated"],
]);

/**
 * Connect codes whose failures are the server's problem rather than the request's.
 *
 * Taken from the Connect code semantics, not from what one server happens to
 * send: `unavailable` and `internal` are explicitly transient, `deadline_exceeded`
 * and `aborted` are timing, and `unknown` carries no claim either way, so one
 * more attempt is the honest reading. `resource_exhausted` is the canonical
 * rate-limit code and is here for servers that use it; Cascade does not, which
 * is what {@link CONNECT_RATE_LIMIT_PATTERN} exists for.
 */
export const CONNECT_TRANSIENT_CODES: ReadonlySet<string> = new Set([
	"unavailable",
	"internal",
	"deadline_exceeded",
	"aborted",
	"resource_exhausted",
	"unknown",
]);

/**
 * THE MESSAGE OUTRANKS THE CODE for rate limits, because the code can be wrong.
 *
 * Cascade reports a per-minute message rate limit as `permission_denied`, which
 * reads as "this credential may not do this" (a permanent authorization
 * failure) when the same sentence says the limit resets in a minute.
 * Classifying on the code alone would either retry genuine authorization
 * failures or, as it did, refuse to retry a rate limit that asked to be retried.
 *
 * The wording is matched with its inflections, because a server says "you are
 * being rate limited" as readily as "rate limit exceeded", and a sentence that
 * asks to be retried in a minute must not be read as a dead credential.
 */
export const CONNECT_RATE_LIMIT_PATTERN = /\brate.?limit(?:ed|ing|s)?\b|\btoo many requests\b/i;

/** A numeric gRPC status or a Connect code name, reduced to the code name. */
export function normalizeConnectCode(code: string): string {
	const trimmed = code.trim().toLowerCase();
	return GRPC_STATUS_NAMES.get(trimmed) ?? trimmed;
}

/**
 * The HTTP status a Connect trailer failure should be reported as, or
 * `undefined` when the trailer names a fault of the request itself
 * (`invalid_argument`, `not_found`, `unimplemented`, ...) which no retry can fix.
 */
export function connectFailureStatus(failure: ConnectTrailerFailure): number | undefined {
	if (CONNECT_RATE_LIMIT_PATTERN.test(failure.message)) return 429;
	const code = normalizeConnectCode(failure.code);
	if (code === "unauthenticated") return 401;
	if (code === "resource_exhausted") return 429;
	if (CONNECT_TRANSIENT_CODES.has(code)) return 503;
	return undefined;
}
