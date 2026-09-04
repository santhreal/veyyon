import { createHash } from "node:crypto";
import packageJson from "../../package.json" with { type: "json" };

/**
 * The provider ids that reach an OpenCode gateway: the OAuth provider and the
 * two API-key providers (`https://opencode.ai/zen/v1`,
 * `https://opencode.ai/zen/go/v1`).
 */
export const OPENCODE_PROVIDER_IDS: readonly string[] = ["opencode", "opencode-go", "opencode-zen"];

const OPENCODE_PROVIDERS: ReadonlySet<string> = new Set(OPENCODE_PROVIDER_IDS);

export function isOpenCodeProvider(provider: string): boolean {
	return OPENCODE_PROVIDERS.has(provider);
}

/**
 * Derive the `x-opencode-session` value from the local session id.
 *
 * Hashed rather than sent verbatim: the gateway needs one stable value per
 * conversation to route a session's requests to the same upstream provider and
 * hit its prompt cache, and nothing more. A digest supplies that without
 * handing a third party the identifier the local session, its transcript and
 * its files are keyed by. `ses_` plus 32 hex characters matches the shape the
 * gateway issues for its own sessions.
 */
export function openCodeSessionHeaderValue(sessionId: string): string {
	return `ses_${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`;
}

/**
 * Headers every OpenCode request carries. The gateway documents both under
 * "Where can I use it?": a client has to identify itself with a narrow
 * user agent, and has to send `x-opencode-session` so the gateway can optimize
 * prompt caching. Traffic that does neither is flagged as abusive.
 *
 * The session header is omitted when the caller has no session id, because a
 * per-request value would defeat the affinity it exists for.
 */
export function getOpenCodeHeaders(sessionId?: string): Record<string, string> {
	const headers: Record<string, string> = { "User-Agent": `Veyyon/${packageJson.version}` };
	if (sessionId) headers["x-opencode-session"] = openCodeSessionHeaderValue(sessionId);
	return headers;
}
