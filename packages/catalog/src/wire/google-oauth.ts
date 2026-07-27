/**
 * Google's OAuth endpoints and the scopes veyyon asks for.
 *
 * Two OAuth flows in this tree sign in to Google, `registry/oauth/google-gemini-cli.ts` and
 * `registry/oauth/google-antigravity.ts`, and a third module refreshes service-account and metadata-server
 * tokens, `providers/google-auth.ts`. All three talked to the same two endpoints and asked for overlapping
 * scopes, and each declared its own copies: the token endpoint appeared three times under two names
 * (`TOKEN_URL` twice, `OAUTH_TOKEN_URL` once), the authorize endpoint twice, and
 * `https://www.googleapis.com/auth/cloud-platform` three times, twice inside a scope array and once as
 * `CLOUD_PLATFORM_SCOPE`.
 *
 * WHY A WRONG SCOPE IS WORSE THAN A WRONG HOST. A mistyped endpoint fails at once with a DNS or 404 error. A
 * mistyped scope succeeds: Google issues a token, and the token simply lacks the permission, so the failure
 * arrives later as a 403 from whatever the token was for, naming the API rather than the scope that was never
 * granted. Nothing in the sign-in flow reports it.
 *
 * WHAT STAYS WITH ITS FLOW. A scope only one product needs stays in that product's module, so Antigravity
 * keeps `cclog` and `experimentsandconfigs` beside its own flow. This module holds what more than one flow
 * has to agree on, and it has no imports, so reading a scope from here costs one module.
 */

/** Google's OAuth 2.0 authorization endpoint, where the browser is sent to consent. */
export const GOOGLE_OAUTH_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

/**
 * Google's OAuth 2.0 token endpoint, which serves both the authorization-code exchange and every refresh.
 *
 * The same endpoint for both, which is why one constant is right: a flow that exchanged its code on one host
 * and refreshed on another would sign in successfully and then fail hours later, when the user is no longer
 * watching the sign-in they would otherwise connect it to.
 */
export const GOOGLE_OAUTH_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Access to Google Cloud APIs, the scope Cloud Code Assist and every service-account token need. */
export const GOOGLE_SCOPE_CLOUD_PLATFORM = "https://www.googleapis.com/auth/cloud-platform";

/** The signed-in account's email address, used to label the stored credential. */
export const GOOGLE_SCOPE_USERINFO_EMAIL = "https://www.googleapis.com/auth/userinfo.email";

/** The signed-in account's basic profile. */
export const GOOGLE_SCOPE_USERINFO_PROFILE = "https://www.googleapis.com/auth/userinfo.profile";

/**
 * The scopes every Google sign-in flow here requests, in the order Google's own consent screen lists them.
 *
 * The order is not cosmetic: the scope string is part of what identifies a grant, so reordering it can present
 * the user with a fresh consent screen for permissions they already gave. Both flows requested exactly these
 * three and each wrote them out, so the trio is stated once and a flow adds only what is its own.
 */
export const GOOGLE_BASE_OAUTH_SCOPES: readonly string[] = [
	GOOGLE_SCOPE_CLOUD_PLATFORM,
	GOOGLE_SCOPE_USERINFO_EMAIL,
	GOOGLE_SCOPE_USERINFO_PROFILE,
];
