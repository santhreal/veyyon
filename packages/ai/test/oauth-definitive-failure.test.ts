/**
 * Contract for {@link isDefinitiveOAuthFailure} — the shared classifier that
 * decides whether an OAuth refresh error tears the credential down (re-login
 * required) or is a transient blip to block-and-retry. A false positive here
 * permanently disables a healthy account, so the 403 / rate-limit / 5xx cases
 * below are load-bearing, not cosmetic.
 */
import { describe, expect, it } from "bun:test";
import { isDefinitiveOAuthFailure } from "@veyyon/ai/auth-storage";

describe("isDefinitiveOAuthFailure", () => {
	it("treats explicit dead-grant errors as definitive", () => {
		for (const msg of [
			'HTTP 400 invalid_grant {"error":"invalid_grant"}',
			"invalid_token",
			"OAuth refresh failed: refresh token revoked",
			'invalid_grant {"error_description":"Refresh token expired"}',
			"unauthorized_client",
		]) {
			expect(isDefinitiveOAuthFailure(msg)).toBe(true);
		}
	});

	it("treats a bare 401 from the token endpoint as definitive", () => {
		expect(isDefinitiveOAuthFailure("HTTP 401 Unauthorized")).toBe(true);
	});

	it("never treats a bare 403 as definitive (WAF / egress / permission, not a dead token)", () => {
		// Regression: a shared broker egress IP that gets 403'd by the provider,
		// or a google PERMISSION_DENIED / account-verification 403, must NOT
		// permanently disable an otherwise-valid credential.
		expect(isDefinitiveOAuthFailure("HTTP 403 Forbidden")).toBe(false);
		expect(isDefinitiveOAuthFailure("403 PERMISSION_DENIED: account verification required")).toBe(false);
		expect(isDefinitiveOAuthFailure("blocked by cloudflare (403)")).toBe(false);
	});

	it("treats rate-limit and server/gateway errors as transient", () => {
		for (const msg of [
			"429 too many requests",
			"HTTP 503 Service Unavailable",
			"500 internal server error",
			"rate limit exceeded",
		]) {
			expect(isDefinitiveOAuthFailure(msg)).toBe(false);
		}
	});

	it("treats network blips as transient (incl. ECONNRESET)", () => {
		for (const msg of [
			"fetch failed: ECONNRESET",
			"fetch failed: ECONNREFUSED",
			"ETIMEDOUT",
			"socket hang up",
			"network error",
			"OAuth token refresh timed out for provider: anthropic",
		]) {
			expect(isDefinitiveOAuthFailure(msg)).toBe(false);
		}
	});

	it("lets a transient signal override a bare 401 (rate-limited auth endpoint)", () => {
		// A 401 wrapped in a rate-limit / 5xx context is the provider throttling,
		// not a dead grant — block-and-retry instead of nuking the row.
		expect(isDefinitiveOAuthFailure("401 unauthorized — 429 too many requests")).toBe(false);
		expect(isDefinitiveOAuthFailure("502 bad gateway (was 401 upstream)")).toBe(false);
	});

	/**
	 * The same override applies to a definitive TOKEN, not only to a bare 401.
	 *
	 * The two branches used to disagree. A definitive pattern returned true
	 * immediately, before the transient guard was consulted at all, so the guard
	 * existed only on the 401 path. `502 bad gateway (was 401 upstream)` was
	 * correctly transient while `502 bad gateway: invalid_token` permanently
	 * disabled the account, on the same class of failure from the same endpoint.
	 *
	 * The messages below are not contrived. A gateway error page echoes the
	 * upstream's `WWW-Authenticate: Bearer error="invalid_token"` header, a
	 * throttler repeats the request body it rejected, a 5xx page happens to
	 * contain the word "revoked". None of them say the grant is dead.
	 *
	 * The asymmetry settles it: a wrong "definitive" destroys a working account
	 * and forces a re-login, a wrong "transient" costs one more retry. Ambiguity
	 * resolves to transient.
	 */
	it("lets a transient signal override a definitive token, not just a 401", () => {
		for (const msg of [
			'502 bad gateway: WWW-Authenticate: Bearer error="invalid_token"',
			"429 too many requests (upstream reported invalid_grant)",
			"503 Service Unavailable — token revoked page",
			"fetch failed: ECONNRESET after invalid_grant response",
			"temporarily unavailable: unauthorized_client",
		]) {
			expect(isDefinitiveOAuthFailure(msg), msg).toBe(false);
		}
	});

	/**
	 * The classifier is handed `String(error)`, and this codebase's errors embed
	 * their cause chain AND their stack, so what arrives carries source paths and
	 * frame names. Matching failure keywords against that means matching against
	 * the names of our own files.
	 *
	 * The message below is the real one, captured from the OAuth refresh race
	 * suite: an unambiguous dead grant whose stack passes through
	 * `withScopedTimeoutSignal (…/utils/src/scoped-timeout.ts:53:16)`, and
	 * `scoped-timeout` matches the transient pattern's `timeout`. Every OAuth
	 * failure refreshed through that helper carried the word, so the transient
	 * guard was reading a frame name rather than anything the provider said. It
	 * went unnoticed only because the definitive check used to return first.
	 *
	 * Renaming an unrelated source file must never change whether a credential is
	 * disabled.
	 */
	it("classifies the message, not the stack trace appended to it", () => {
		const realDeadGrant =
			"OAuthError: Anthropic token refresh request failed. url=https://api.anthropic.com/v1/oauth/token; " +
			'details=ProviderHttpError: HTTP request failed. status=400; body={"error": "invalid_grant", ' +
			'"error_description": "Refresh token not found or invalid"}; ' +
			"stack=ProviderHttpError: HTTP request failed. status=400\n" +
			"    at async withScopedTimeoutSignal (/repo/packages/utils/src/scoped-timeout.ts:53:16)\n" +
			"    at async refreshAnthropicToken (/repo/packages/ai/src/registry/oauth/anthropic.ts:316:24)";

		expect(isDefinitiveOAuthFailure(realDeadGrant)).toBe(true);
	});

	/**
	 * The same in the other direction: a genuinely transient failure must stay
	 * transient even when its stack runs through a file whose name reads like a
	 * dead grant. This is the half that keeps stack-stripping from being a
	 * one-way convenience.
	 */
	it("does not let a stack frame make a transient failure look definitive", () => {
		const throttled =
			"OAuthError: token refresh failed. details=HTTP 429 Too Many Requests; " +
			"stack=Error\n    at refreshInvalidGrantRecovery (/repo/packages/ai/src/invalid_grant-recovery.ts:9:1)";

		expect(isDefinitiveOAuthFailure(throttled)).toBe(false);
	});

	/**
	 * The twin, because a guard that swallowed every definitive failure would be
	 * far worse than the bug: a genuinely dead grant must still be recognised,
	 * including the real Google wording, which contains "expired" and "revoked"
	 * and no transient signal at all. Without this the fix would leave a dead
	 * credential in rotation forever, failing every request it was handed.
	 */
	it("still disables on a real dead grant that carries no transient signal", () => {
		for (const msg of [
			'invalid_grant {"error_description":"Token has been expired or revoked."}',
			'HTTP 400 {"error":"invalid_grant"}',
			"unauthorized_client",
			"HTTP 401 Unauthorized",
		]) {
			expect(isDefinitiveOAuthFailure(msg), msg).toBe(true);
		}
	});
});
