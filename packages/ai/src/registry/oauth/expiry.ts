/**
 * When an OAuth credential should be treated as expired.
 *
 * Every provider hands back a `expires_in` in seconds (or a JWT `exp` in
 * seconds), and every one of them used to be turned into an absolute timestamp
 * at its own call site with its own copy of `Date.now() + n * 1000 - 5 * 60 *
 * 1000`. Thirteen copies, three different skews, and no validation anywhere.
 *
 * That mattered for two reasons.
 *
 * The SKEW is a policy decision, not arithmetic. It is the margin by which a
 * credential is considered expired before it really is, so a request that is
 * already in flight when the token dies does not fail. Changing it means
 * changing thirteen numbers, and one of them was already different.
 *
 * The VALIDATION was missing entirely. A provider that returns `expires_in` as a
 * string, or omits it from an error-shaped response the parser waved through,
 * produced `NaN`, and `NaN` propagates: `Date.now() + NaN` is `NaN`, and every
 * later comparison against it is FALSE. The refresh check is
 * `Date.now() + skew < expires`, so a `NaN` expiry means "always refresh" and
 * the agent hammers the provider's token endpoint on every single request. A
 * negative or absurdly large value is the same class of problem in the other
 * direction: a credential that never refreshes, or one that refreshes forever.
 *
 * So this module is the one home for the conversion, and it fails LOUDLY on a
 * value it cannot use rather than storing a poisoned timestamp that only shows
 * up later as a refresh loop.
 */

import * as AIError from "../../error";

/**
 * How early a credential is treated as expired.
 *
 * Five minutes, which is long enough to cover a slow request that was issued
 * just before the real expiry and short enough that it does not throw away a
 * meaningful share of a typical one-hour token.
 */
export const OAUTH_EXPIRY_SKEW_MS = 5 * 60 * 1000;

/**
 * The longest lifetime accepted from a provider, as a sanity bound.
 *
 * A year. Real access tokens live for minutes to hours; refresh tokens can live
 * for months. Anything past a year is a corrupted value or a unit mistake, and
 * storing it would mean a credential that is never refreshed and never noticed
 * until the provider starts rejecting it.
 *
 * It is a COARSE bound, and deliberately so: it does not catch every
 * seconds/milliseconds mix-up. A one-hour token sent in milliseconds is
 * 3_600_000 "seconds", about 41 days, which passes. Tightening below that would
 * start rejecting the genuinely long-lived tokens some providers issue, and a
 * refused login is a worse failure than a credential refreshed later than ideal.
 * The gap is pinned in `test/oauth-expiry-owner.test.ts` so it stays a decision
 * rather than an assumption.
 */
const MAX_EXPIRES_IN_SECONDS = 365 * 24 * 60 * 60;

export interface ExpiryOptions {
	/** Reference time. Defaults to now. Pass the response's own issue time when
	 * the caller has one, so a slow round trip does not eat into the lifetime. */
	issuedAtMs?: number;
	/**
	 * Override the early-expiry margin. Pass `0` only where the provider's own
	 * refresh path already carries the margin, and say why at the call site.
	 */
	skewMs?: number;
	/** Provider name, used only to make the failure message actionable. */
	provider?: string;
}

function reject(provider: string | undefined, detail: string): never {
	const who = provider ? `${provider} ` : "";
	throw new AIError.OAuthError(
		`The ${who}token response carried an unusable expiry: ${detail}. ` +
			`Storing it would leave the credential either never refreshed or refreshed on every request.`,
		{ kind: "validation", provider },
	);
}

/**
 * Absolute expiry (ms since epoch) for a credential the provider says lives
 * `expiresInSeconds` seconds.
 *
 * Throws on anything that is not a finite, positive, plausibly-sized number.
 *
 * @example
 * ```ts
 * expires: credentialExpiryFromExpiresIn(tokenData.expires_in, { provider: "anthropic" })
 * ```
 */
export function credentialExpiryFromExpiresIn(expiresInSeconds: unknown, options: ExpiryOptions = {}): number {
	const { issuedAtMs = Date.now(), skewMs = OAUTH_EXPIRY_SKEW_MS, provider } = options;
	if (typeof expiresInSeconds !== "number") {
		reject(provider, `expires_in was ${typeof expiresInSeconds}, not a number`);
	}
	if (!Number.isFinite(expiresInSeconds)) {
		reject(provider, `expires_in was ${expiresInSeconds}`);
	}
	if (expiresInSeconds <= 0) {
		reject(provider, `expires_in was ${expiresInSeconds}, so the token is already expired on arrival`);
	}
	if (expiresInSeconds > MAX_EXPIRES_IN_SECONDS) {
		reject(
			provider,
			`expires_in was ${expiresInSeconds} seconds, past the ${MAX_EXPIRES_IN_SECONDS}-second sanity bound ` +
				`(this is normally a seconds/milliseconds mix-up)`,
		);
	}
	return issuedAtMs + expiresInSeconds * 1000 - skewMs;
}

/**
 * Absolute expiry for a credential whose lifetime comes from a JWT's `exp`
 * claim, which is an absolute time in SECONDS rather than a duration.
 *
 * Separate from {@link credentialExpiryFromExpiresIn} because the two are easy
 * to confuse and confusing them is silent: an `exp` fed through the duration
 * form produces a timestamp roughly fifty-five years in the future.
 */
export function credentialExpiryFromJwtExp(expSeconds: unknown, options: ExpiryOptions = {}): number {
	const { skewMs = OAUTH_EXPIRY_SKEW_MS, provider } = options;
	if (typeof expSeconds !== "number" || !Number.isFinite(expSeconds)) {
		reject(provider, `the JWT \`exp\` claim was ${String(expSeconds)}`);
	}
	if (expSeconds <= 0) {
		reject(provider, `the JWT \`exp\` claim was ${expSeconds}`);
	}
	return expSeconds * 1000 - skewMs;
}
