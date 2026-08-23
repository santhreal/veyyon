/**
 * The wire vocabulary for a usage report, in one place and built on first use.
 *
 * WHY IT IS NOT AT MODULE SCOPE. Building these costs nothing — a schema is under a
 * millisecond — but reaching them means evaluating arktype, and that is 362ms on its own
 * with zero schemas built. `usage.ts` declared them at module scope, `auth-storage.ts`
 * imports `usage.ts`, `api-registry.ts` reaches `auth-storage.ts`, and `stream.ts` reaches
 * `api-registry.ts`, so every launch paid arktype's evaluation before the first frame in
 * order to hold a validator for a report no session had asked for. Validating a provider's
 * usage response is a request-time concern and now loads when a response arrives.
 *
 * WHY IT IS ONE MODULE. The same nine schemas were written twice, identically: once at
 * module scope in `usage.ts` and once inside `wireSchemas()` in `auth-broker/wire-schemas.ts`,
 * where the broker's `/v1/usage` response embeds them. Two copies of one vocabulary disagree
 * by a field eventually, and the field that goes missing is the one a report needed.
 */
import { once } from "@veyyon/utils/abortable";
import { type } from "arktype";

/**
 * The nine schemas a usage report is validated against, built once per process.
 *
 * Memoized because arktype's evaluation is the expensive part and the schemas are immutable;
 * the broker validates a response per request and must not rebuild them each time.
 */
export const usageWireSchemas = once(() => {
	const unit = type("'percent' | 'tokens' | 'requests' | 'usd' | 'minutes' | 'bytes' | 'unknown'");
	const status = type("'ok' | 'warning' | 'exhausted' | 'unknown'");

	const window = type({
		id: "string",
		label: "string",
		"durationMs?": "number",
		"resetsAt?": "number",
	});

	const amount = type({
		"used?": "number",
		"limit?": "number",
		"remaining?": "number",
		"usedFraction?": "number",
		"remainingFraction?": "number",
		unit,
	});

	const scope = type({
		provider: "string",
		"accountId?": "string",
		"projectId?": "string",
		"orgId?": "string",
		"modelId?": "string",
		"tier?": "string",
		"windowId?": "string",
		"shared?": "boolean",
	});

	const limit = type({
		id: "string",
		label: "string",
		scope,
		"window?": window,
		amount,
		"status?": status,
		"notes?": "string[]",
	});

	const resetCreditDetail = type({
		"grantedAt?": "string",
		"expiresAt?": "string",
		"status?": "string",
	});

	const resetCredits = type({
		availableCount: "number",
		"credits?": resetCreditDetail.array(),
	});

	const report = type({
		provider: "string",
		fetchedAt: "number",
		limits: limit.array(),
		"resetCredits?": resetCredits,
		"notes?": "string[]",
		"metadata?": { "[string]": "unknown" },
		// `raw` is provider-specific and may be anything; the broker strips it before
		// sending the report over the wire, so accept-but-ignore here.
		"raw?": "unknown",
	});

	return { unit, status, window, amount, scope, limit, resetCreditDetail, resetCredits, report };
});
