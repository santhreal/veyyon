import { tryParseJson } from "./json";

/**
 * Decode the payload of a JWT: the claims JSON in the middle segment.
 *
 * A JWT is three base64url segments joined by dots: `header.payload.signature`.
 * This reads the payload and parses it, returning null when the token is not a
 * well-formed three-segment JWT or the payload is not JSON.
 *
 * The payload is base64url, not plain base64: it uses `-` and `_` in place of
 * `+` and `/` and omits padding. Node and Bun decode that directly with the
 * `"base64url"` encoding, so callers never hand-roll the `-_`→`+/` replacement
 * or the padding math. Decoding plain `"base64"` instead silently corrupts any
 * payload that contains `-` or `_`, which is the bug this owner exists to remove.
 *
 * This does not verify the signature. Use it to read unauthenticated claims
 * such as `exp` from a token you already trust, never to authenticate one.
 */
export function decodeJwtPayload<T = Record<string, unknown>>(token: string): T | null {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	const payload = parts[1];
	if (!payload) return null;
	const decoded = Buffer.from(payload, "base64url").toString("utf8");
	return tryParseJson<T>(decoded);
}
