/**
 * Request and response helpers shared by the auth-broker and auth-gateway
 * HTTP servers: the JSON response shape, the bearer allow-list check, and
 * peer resolution for request logs.
 */
import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";

const JSON_HEADERS = {
	"Content-Type": "application/json",
	"X-Content-Type-Options": "nosniff",
} as const;

export function json(status: number, body: unknown, headers?: Record<string, string>): Response {
	return new Response(JSON.stringify(body) ?? "null", {
		status,
		headers: headers ? { ...JSON_HEADERS, ...headers } : JSON_HEADERS,
	});
}

/**
 * Client address for request logs: the first `X-Forwarded-For` hop, else
 * `X-Real-IP`, else `"unknown"`. An empty value falls through to the next.
 */
export function resolvePeer(req: Request): string {
	return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
}

/**
 * Constant-time byte comparison. Unequal lengths compare every byte of the
 * longer input, so the length does not leak through timing either.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length === b.length) return nodeTimingSafeEqual(a, b);
	const len = Math.max(a.length, b.length);
	let diff = a.length ^ b.length;
	for (let i = 0; i < len; i++) {
		const av = i < a.length ? a[i] : 0;
		const bv = i < b.length ? b[i] : 0;
		diff |= av ^ bv;
	}
	return diff === 0;
}

const TOKEN_ENCODER = new TextEncoder();
const BEARER_HEADER = /^Bearer\s+(.+)$/i;

/**
 * Bearer tokens a server accepts. An empty list accepts every request, which
 * a server binds to loopback only.
 */
export class BearerAllowList {
	readonly #tokens: readonly Uint8Array[];

	constructor(tokens: Iterable<string>) {
		this.#tokens = Array.from(new Set(tokens), token => TOKEN_ENCODER.encode(token));
	}

	/**
	 * Whether `req` presents an accepted `Authorization: Bearer` token. The
	 * token is every byte after the scheme's whitespace; `Headers` already
	 * strips the value's surrounding HTTP whitespace. Every accepted token is
	 * compared in constant time, whatever position matches.
	 */
	authorizes(req: Request): boolean {
		if (this.#tokens.length === 0) return true;
		const header = req.headers.get("authorization");
		if (!header) return false;
		const match = BEARER_HEADER.exec(header);
		if (!match) return false;
		const presented = TOKEN_ENCODER.encode(match[1]);
		let ok = false;
		for (const expected of this.#tokens) {
			if (timingSafeEqual(presented, expected)) ok = true;
		}
		return ok;
	}
}

/**
 * Whether `req` presents a bearer token in `tokens`. Encodes `tokens` on every
 * call; a server that checks many requests holds a {@link BearerAllowList}.
 */
export function isAuthorized(req: Request, tokens: Iterable<string>): boolean {
	return new BearerAllowList(tokens).authorizes(req);
}
