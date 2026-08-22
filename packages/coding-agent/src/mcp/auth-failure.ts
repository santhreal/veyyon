/**
 * What a session says when a CONFIGURED MCP credential cannot be presented.
 *
 * WHAT WAS WRONG. `MCPManager.#resolveAuthConfig()` resolved a stored OAuth
 * credential inside a `try`, and every way that resolution could fail ended at
 * `logger.warn("Failed to resolve OAuth credential")`. The function then
 * returned the config it had — one with no `Authorization` header — and the
 * connect proceeded. Three different credential states produced the same
 * outcome:
 *
 * 1. A definitive rejection (`invalid_grant`), where the refresh helper
 *    disables the row and answers `{ credential: undefined, removed: true }`.
 * 2. A refresh token the auth broker holds and redacts locally, which this
 *    process cannot renew at all.
 * 3. A credential-store read or write that failed, which says nothing about
 *    the credential itself.
 *
 * In all three the operator saw whatever the SERVER said about an
 * unauthenticated request — an HTTP 401, a provider's own error page, a
 * lockout after enough of them — and nothing about the credential or the
 * command that fixes it. The request was also sent: connection metadata to a
 * server that was never going to answer, and a failed-auth counter on the far
 * side.
 *
 * WHAT IS TRUE NOW. `lookupMcpOAuthCredential` returns a lookup only when a
 * stored OAuth credential was FOUND (see `oauth-credentials.ts`), so the
 * invariant is exact: if resolution began with a credential, the connection
 * either carries one or is not attempted. The reasons are separated because
 * their remedies differ, and the message names the remedy.
 *
 * WHAT THIS DOES NOT COVER. A server with no stored credential at all is not
 * this module's business: nothing was configured, an unauthenticated connect is
 * what the operator asked for, and the server's 401 is the honest answer.
 * `/mcp reauth`'s deliberate unauthenticated probe passes `oauth: false` and
 * never reaches here. Nor does this module judge a live token: a refresh that
 * fails while the access token is still valid keeps connecting, because a
 * working session is worth more than a punctual complaint.
 */
import { isDefinitiveOAuthFailure } from "@veyyon/ai/error/auth-classify";
import { errorMessage } from "@veyyon/utils";
import type { MCPStoredOAuthCredential } from "./oauth-flow";

/**
 * Every reason a configured credential could not be presented.
 *
 * Three states, three different operator actions. `revoked` needs a new
 * authorization, `broker-redacted` needs one through the broker, and
 * `store-unavailable` is worth a retry first because it is the only one that
 * says nothing about the credential.
 *
 * The list is the declaration and the TYPE is derived from it, so a fourth
 * reason cannot exist in the type alone: adding one means editing this array,
 * which a run-time sweep pins by exact equality, and `mcpAuthRequiredMessage`
 * stops compiling until the new member has a sentence.
 */
export const MCP_AUTH_FAILURE_REASONS = ["revoked", "broker-redacted", "store-unavailable"] as const;

export type MCPAuthFailureReason = (typeof MCP_AUTH_FAILURE_REASONS)[number];

/**
 * The refresh token exists but only the auth broker can use it.
 *
 * A class rather than a string test. The previous spelling threw a sentence and
 * then looked for `"broker-redacted"` inside it — a substring the sentence never
 * contained, so both branches that meant to recognise this case were dead and
 * the failure fell through to the generic warn.
 */
export class MCPBrokerRedactedRefreshError extends Error {
	constructor(target: string) {
		super(
			`The OAuth refresh token for ${target} is held by the auth broker and redacted locally, so this process cannot refresh it.`,
		);
		this.name = "MCPBrokerRedactedRefreshError";
	}
}

/** The sentence an operator reads, and the command that fixes it. */
export function mcpAuthRequiredMessage(reason: MCPAuthFailureReason, target: string): string {
	switch (reason) {
		case "revoked":
			return `The stored OAuth credential for ${target} was rejected and cleared, so there is nothing left to send and the connection was not attempted. Fix: run \`/mcp reauth <name>\` to authorize again; \`/mcp list\` gives the server's name.`;
		case "broker-redacted":
			return `The OAuth access token for ${target} has expired and its refresh token is held by the auth broker and redacted locally, so this process cannot renew it. Fix: run \`/mcp reauth <name>\` to authorize again through the broker; \`/mcp list\` gives the server's name.`;
		case "store-unavailable":
			return `The stored OAuth credential for ${target} could not be read or renewed, so the connection was not attempted rather than sent without it. Fix: run \`/mcp reconnect <name>\` to retry; if it keeps failing, run \`/mcp reauth <name>\`. \`/mcp list\` gives the server's name.`;
	}
}

/**
 * A configured MCP credential could not be presented, so nothing was sent.
 *
 * Thrown from the resolution path, which means it travels the route every other
 * connect failure already travels: the `errors` map from `connectServers`, the
 * `failed` status event, `/mcp test`, and the tool-result wrapper in
 * `tool-bridge.ts`. No new surface, and the reader gets the credential's state
 * instead of the server's opinion of an anonymous request.
 *
 * The message is built from the reason and the server's URL or command only.
 * The underlying failure travels as `cause` for the log, never in the sentence:
 * a refresh endpoint's response body is exactly the sort of text that carries a
 * token, and a diagnostic that prints what it was protecting is the leak it was
 * reporting.
 */
export class MCPAuthRequiredError extends Error {
	readonly reason: MCPAuthFailureReason;
	readonly target: string;

	constructor(reason: MCPAuthFailureReason, target: string, options?: { cause?: unknown }) {
		super(mcpAuthRequiredMessage(reason, target), options);
		this.name = "MCPAuthRequiredError";
		this.reason = reason;
		this.target = target;
	}
}

/** True for the error this module throws, without importing the manager. */
export function isMcpAuthRequiredError(error: unknown): error is MCPAuthRequiredError {
	return error instanceof MCPAuthRequiredError;
}

/**
 * What to do with a credential whose refresh threw.
 *
 * `credential` means connect with what is on disk; `failure` means refuse to
 * connect and say why. The only case that keeps connecting is a broker-held
 * refresh token whose ACCESS token is still valid — the refresh fires up to five
 * minutes early (`REFRESH_BUFFER_MS`), so this is a session that still works and
 * would otherwise be ended by a renewal it did not need yet.
 */
export type MCPAuthResolution =
	| { kind: "credential"; credential: MCPStoredOAuthCredential; brokerRedacted: boolean }
	| { kind: "failure"; reason: MCPAuthFailureReason; cause?: unknown };

export function classifyMcpAuthFailure(
	error: unknown,
	observed: MCPStoredOAuthCredential | undefined,
	nowMs: number,
): MCPAuthResolution {
	if (error instanceof MCPBrokerRedactedRefreshError) {
		if (observed && observed.expires > nowMs) {
			return { kind: "credential", credential: observed, brokerRedacted: true };
		}
		return { kind: "failure", reason: "broker-redacted", cause: error };
	}
	if (isDefinitiveOAuthFailure(errorMessage(error))) return { kind: "failure", reason: "revoked", cause: error };
	return { kind: "failure", reason: "store-unavailable", cause: error };
}
