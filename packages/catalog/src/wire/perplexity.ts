/**
 * The client identity veyyon presents to Perplexity's consumer endpoints.
 *
 * Perplexity has no documented API for the consumer surface, so both paths that use it identify as the macOS
 * native app (`ai.perplexity.mac`), which is what gets a request past the Cloudflare managed challenge and lets a
 * signed-in account select its Pro models. Two packages take part, and they are two halves of ONE session:
 *
 * - `@veyyon/ai`'s `registry/oauth/perplexity.ts` performs the email-OTP login against
 *   `www.perplexity.ai/api/auth/*` and mints the session JWT.
 * - `@veyyon/coding-agent`'s `web/search/providers/perplexity.ts` spends that session on
 *   `www.perplexity.ai/rest/sse/perplexity_ask`.
 *
 * WHY THESE VALUES CANNOT LIVE IN TWO PLACES. A session minted while claiming to be one app version and then
 * spent while claiming to be another is the mismatch the challenge exists to catch, and the failure is not an
 * error: the ask endpoint answers 200 and silently serves the anonymous free `turbo` model regardless of
 * `model_preference`, so a user with a Pro account gets free-tier answers and nothing says why. The version is
 * also sent twice per search, once as the `X-App-ApiVersion` header and once as the request body's `version`
 * field, so even inside one request there were two spellings to keep in step.
 *
 * These are values to be REPLACED WHOLESALE when the app is next observed, not edited apart. Bumping the app
 * version means bumping the User-Agent build number with it, since a real 2.18 client does not report build 641
 * of a different release.
 *
 * This module has no imports, so either package pays one module for the identity.
 */

/** The consumer web origin. Both the login flow and the ask endpoint live under it. */
export const PERPLEXITY_WEB_ORIGIN = "https://www.perplexity.ai";

/** The macOS app's bundle identifier, used to read its stored token out of NSUserDefaults. */
export const PERPLEXITY_NATIVE_APP_BUNDLE_ID = "ai.perplexity.mac";

/**
 * The macOS app's User-Agent, verbatim.
 *
 * `Perplexity/641` is the app build, and the `CFNetwork` and `Darwin` tokens are what a Catalyst app on macOS
 * actually sends. Reported unchanged rather than assembled from the host's real OS version, because a Darwin
 * token that does not match the CFNetwork build is a combination no real client produces.
 */
export const PERPLEXITY_NATIVE_APP_USER_AGENT = "Perplexity/641 CFNetwork/1568 Darwin/25.2.0";

/**
 * The app's API version, sent as `X-App-ApiVersion` and as the `version` field of an ask request body.
 *
 * Paired with the User-Agent above: both describe the same observed release, and moving one without the other
 * describes a client that does not exist.
 */
export const PERPLEXITY_NATIVE_APP_API_VERSION = "2.18";

/** Request header names the consumer endpoints read. Names, not values, so a typo is one place. */
export const PERPLEXITY_HEADERS = {
	API_VERSION: "X-App-ApiVersion",
	API_CLIENT: "X-App-ApiClient",
	REQUEST_ID: "X-Request-ID",
	/** The ask endpoint distinguishes a fresh submit from a follow-up; `"submit"` is what the app sends first. */
	REQUEST_REASON: "X-Perplexity-Request-Reason",
} as const;

/**
 * The two headers that together say "I am the macOS app", ready to spread into a request.
 *
 * Both halves are required. The User-Agent alone gets past the challenge but leaves the request looking like an
 * app of unknown version, and the version alone contradicts whatever User-Agent is sent instead.
 */
export const PERPLEXITY_NATIVE_APP_HEADERS: Readonly<Record<string, string>> = {
	"User-Agent": PERPLEXITY_NATIVE_APP_USER_AGENT,
	[PERPLEXITY_HEADERS.API_VERSION]: PERPLEXITY_NATIVE_APP_API_VERSION,
};
