/**
 * Constants for OpenAI Codex (ChatGPT OAuth) backend
 */

import { decodeJwtPayload } from "@veyyon/utils/jwt";

export const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

/**
 * Pinned OpenAI Codex client version (corresponds to @openai/codex package version).
 */
export const CODEX_CLIENT_VERSION = "0.144.1";

export const OPENAI_HEADERS = {
	BETA: "OpenAI-Beta",
	ACCOUNT_ID: "chatgpt-account-id",
	ORIGINATOR: "originator",
	VERSION: "version",
	SESSION_ID: "session_id",
	CONVERSATION_ID: "conversation_id",
	SCOPED_SESSION_ID: "session-id",
	THREAD_ID: "thread-id",
	INSTALLATION_ID: "x-codex-installation-id",
	WINDOW_ID: "x-codex-window-id",
	TURN_METADATA: "x-codex-turn-metadata",
	PARENT_THREAD_ID: "x-codex-parent-thread-id",
	SUBAGENT: "x-openai-subagent",
	/** Responses Lite transport marker (codex-rs `add_responses_lite_header`); value is always `"true"`. */
	RESPONSES_LITE: "x-openai-internal-codex-responses-lite",
} as const;

export const OPENAI_HEADER_VALUES = {
	BETA_RESPONSES: "responses=experimental",
	BETA_RESPONSES_WEBSOCKETS_V2: "responses_websockets=2026-02-06",
	ORIGINATOR_CODEX: "pi",
} as const;

export const URL_PATHS = {
	RESPONSES: "/responses",
	CODEX_RESPONSES: "/codex/responses",
} as const;

/**
 * The namespace under which a ChatGPT OAuth token carries its Codex authorization claims.
 *
 * This is a LOOKUP KEY into a decoded JWT payload, not a URL that anything requests. OpenAI namespaces
 * private claims by URI, so the payload holds `{"https://api.openai.com/auth": {chatgpt_account_id: "..."}}`
 * and reading it means indexing by these exact bytes. A copy that drifts does not fail: the index returns
 * `undefined`, the account id comes back absent, and a perfectly valid token is treated as one that carries no
 * account. Downstream that reads as "not signed in to ChatGPT" rather than as a bug.
 */
export const CODEX_JWT_AUTH_CLAIM = "https://api.openai.com/auth" as const;

/**
 * @deprecated Renamed to {@link CODEX_JWT_AUTH_CLAIM}, which says whose claim it is and which of OpenAI's two
 * namespaces it names. Kept as an alias of the same value because this module's exports are public surface.
 */
export const JWT_CLAIM_PATH = CODEX_JWT_AUTH_CLAIM;

/**
 * The namespace under which the same token carries the signed-in user's profile, holding `email`.
 *
 * Separate from the auth claim and easy to confuse with it, since the two URIs differ by one path segment.
 * Reading the account id out of the profile claim, or the email out of the auth claim, yields `undefined`
 * silently in both directions.
 */
export const CODEX_JWT_PROFILE_CLAIM = "https://api.openai.com/profile" as const;

/** Who a Codex access token says it belongs to, as far as its claims state it. */
export interface CodexTokenIdentity {
	/** `chatgpt_account_id`, sent back as the `chatgpt-account-id` request header. */
	accountId?: string;
	/** The signed-in email, lowercased, used to match a stored credential to an account. */
	email?: string;
}

/** Trimmed, or absent when the claim held nothing usable. */
function usableClaim(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Read the Codex identity claims out of an ALREADY-DECODED JWT payload.
 *
 * The payload-level entry point exists for callers that decode a token once and read several things out of it,
 * so they are not made to decode it twice to use this.
 *
 * An empty or whitespace-only claim is reported as ABSENT rather than passed through. That is the part worth
 * stating: `chatgpt_account_id` becomes the `chatgpt-account-id` header, and sending that header with an empty
 * value is worse than omitting it, because the backend answers a malformed-account error rather than falling
 * back to the token's own account. One of the four hand-rolled copies this function replaces returned `""`
 * unchanged for exactly that path.
 */
export function readCodexClaimsFromPayload(payload: Record<string, unknown>): CodexTokenIdentity {
	const auth = payload[CODEX_JWT_AUTH_CLAIM];
	const profile = payload[CODEX_JWT_PROFILE_CLAIM];
	const accountId =
		auth !== null && typeof auth === "object"
			? usableClaim((auth as Record<string, unknown>).chatgpt_account_id)
			: undefined;
	const rawEmail =
		profile !== null && typeof profile === "object"
			? usableClaim((profile as Record<string, unknown>).email)
			: undefined;
	return { accountId, email: rawEmail?.toLowerCase() };
}

/**
 * Decode a Codex access token and read who it belongs to.
 *
 * Returns an identity with both fields absent for a token that is missing, malformed, or simply not a Codex
 * token, because none of those are distinguishable from "carries no account claim" at a call site that only
 * wants the account id, and every caller of the four copies this replaces treated them the same way.
 */
export function readCodexTokenIdentity(accessToken: string | undefined): CodexTokenIdentity {
	if (!accessToken) return {};
	const payload = decodeJwtPayload(accessToken);
	if (!payload) return {};
	return readCodexClaimsFromPayload(payload);
}

/**
 * Extract account ID from a Codex JWT access token.
 * Returns undefined if the token is not a valid Codex JWT, or carries no usable account claim.
 */
export function getCodexAccountId(accessToken: string | undefined): string | undefined {
	return readCodexTokenIdentity(accessToken).accountId;
}

/** Extract the signed-in email from a Codex JWT access token, lowercased. */
export function getCodexAccountEmail(accessToken: string | undefined): string | undefined {
	return readCodexTokenIdentity(accessToken).email;
}
