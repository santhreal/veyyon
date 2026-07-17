/**
 * Minimal JWT payload inspection for OAuth token lifetimes.
 *
 * One owner for the "decode the exp claim without verifying the signature"
 * operation — per-provider refresh flows only need the expiry hint; signature
 * verification is the provider's job.
 */

/** The `exp` claim of a JWT in epoch milliseconds, or undefined when the token is not a decodable JWT. */
export function jwtExpiryMs(token: string): number | undefined {
	try {
		const [, payload] = token.split(".");
		if (!payload) return undefined;
		const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
		if (typeof decoded.exp === "number" && Number.isFinite(decoded.exp)) {
			return decoded.exp * 1000;
		}
	} catch {
		// Not a JWT (opaque token) — callers fall back to their own default lifetime.
	}
	return undefined;
}
