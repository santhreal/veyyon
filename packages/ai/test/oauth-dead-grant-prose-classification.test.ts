/**
 * A dead OAuth grant is dead whether the provider says `invalid_grant` or says
 * so in English.
 *
 * WHY THIS SUITE EXISTS. `isDefinitiveOAuthFailure` decides what happens after a
 * refresh fails: definitive disables the credential once and tells the user to
 * run `/login`, transient blocks it for five minutes and retries. It recognised
 * the RFC 6749 §5.2 machine codes and a bare `401`, and nothing else. Kimi
 * rejects a dead grant with `400` and the prose
 * `The provided authorization grant is invalid`, which is neither. Every dead
 * Kimi grant therefore classified as TRANSIENT, and the consequences compounded:
 *
 *  - the credential row was never disabled, so `hasAuth` kept reporting the
 *    provider as signed in;
 *  - `agent-session` took the "signed in, but could not get a usable token right
 *    now" branch and blamed a lapsed subscription or unpaid balance, which is
 *    not what happened and sends the user to the wrong place;
 *  - the five-minute block expired and the whole thing repeated, every five
 *    minutes, indefinitely. The operator report was "this constantly happens".
 *
 * It surfaced only with more than one account signed in, because usage ranking
 * (and therefore this whole resolution path) only engages when a provider has
 * two or more credentials to choose between.
 *
 * The fix has two halves and both are pinned here, because either alone leaves
 * the bug reachable: the Kimi refresh error now carries the machine-readable
 * `error` code, and the classifier now also recognises the prose spelling that
 * any provider might return.
 *
 * The direction of error matters and is asserted in both directions below. A
 * wrong "definitive" tears down a working account over a blip, so the transient
 * guard stays authoritative and the prose pattern stays narrow: an invalidity
 * word has to sit next to the grant or the refresh token, not merely somewhere
 * in the same message.
 */
import { describe, expect, it } from "bun:test";
import { isDefinitiveOAuthFailure } from "../src/error/auth-classify";

describe("dead-grant classification", () => {
	it("classifies the exact Kimi rejection that caused the loop", () => {
		// The verbatim string from the operator's log (veyyon.2026-07-24.log),
		// which classified transient and produced the five-minute retry loop.
		expect(
			isDefinitiveOAuthFailure(
				"OAuthError: Kimi token refresh failed: 400: The provided authorization grant is invalid",
			),
		).toBe(true);
	});

	it("classifies the prose spellings providers actually return", () => {
		const definitive = [
			"The provided authorization grant is invalid",
			"authorization grant is expired",
			"The grant has been revoked",
			"refresh token is invalid",
			"refresh token was revoked",
			"Refresh token not found or invalid",
			"invalid refresh token",
			"expired authorization grant",
			"invalid_grant",
			"401 Unauthorized",
		];
		for (const message of definitive) {
			expect({ message, definitive: isDefinitiveOAuthFailure(message) }).toEqual({ message, definitive: true });
		}
	});

	it("still refuses to disable an account over an ambiguous or transient message", () => {
		// The asymmetry the classifier is built around. Each of these contains an
		// invalidity word, and none of them proves the grant is dead.
		const transient = [
			"400: invalid request body",
			"The model name is invalid",
			"Your session is invalid, please retry",
			"fetch failed",
			"ETIMEDOUT",
			"500 Internal Server Error",
			"429 Too Many Requests",
		];
		for (const message of transient) {
			expect({ message, definitive: isDefinitiveOAuthFailure(message) }).toEqual({ message, definitive: false });
		}
	});

	it("keeps the transient guard authoritative over the new prose form", () => {
		// A throttled or broken auth endpoint whose body echoes the dead-grant
		// prose must NOT disable the credential. This is the failure mode the
		// guard ordering exists for, and widening the definitive pattern is
		// exactly the change that could have reintroduced it.
		expect(isDefinitiveOAuthFailure("429 Too Many Requests: The provided authorization grant is invalid")).toBe(
			false,
		);
		expect(isDefinitiveOAuthFailure("502 Bad Gateway: refresh token is invalid")).toBe(false);
		expect(isDefinitiveOAuthFailure("timeout while reading: authorization grant is expired")).toBe(false);
	});

	it("ignores our own stack frames when classifying", () => {
		// `String(error)` carries the stack, and `scoped-timeout.ts` contains the
		// word `timeout`. A dead grant refreshed through that helper must still
		// read as dead.
		const withStack = [
			"OAuthError: Kimi token refresh failed: 400: invalid_grant: The provided authorization grant is invalid",
			"    at async withScopedTimeoutSignal (/repo/packages/utils/src/scoped-timeout.ts:53:16)",
		].join("\n");
		expect(isDefinitiveOAuthFailure(withStack)).toBe(true);
	});
});
