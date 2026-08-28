/** What a session says when a CONFIGURED MCP credential cannot be presented. credential inside a `try`, and every way that resolution could fail ended at */
import { isDefinitiveOAuthFailure } from "@veyyon/ai/error/flags";
import { errorMessage } from "@veyyon/utils";
import type { MCPStoredOAuthCredential } from "./oauth-flow";

/** Every reason a configured credential could not be presented. Three states, three different operator actions. `revoked` needs a new */
export const MCP_AUTH_FAILURE_REASONS = ["revoked", "broker-redacted", "store-unavailable"] as const;

export type MCPAuthFailureReason = (typeof MCP_AUTH_FAILURE_REASONS)[number];

/** The refresh token exists but only the auth broker can use it. A class rather than a string test. The previous spelling threw a sentence and */
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

/** A configured MCP credential could not be presented, so nothing was sent. Thrown from the resolution path, which means it travels the route every other */
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

/** A configured MCP value names an environment variable that is unset or empty. The connection is refused instead of attempted. The old resolution fell back */
export class MCPUnresolvedEnvReferenceError extends Error {
	readonly variable: string;

	constructor(details: { variable: string; empty: boolean; describedAs: string; target: string }) {
		super(
			`The ${details.describedAs} for ${details.target} refers to the environment variable ${details.variable}, which is ${details.empty ? "set but empty" : "not set"}, so the connection was not attempted rather than sent with the variable's own name as the value. Fix: export ${details.variable} with the value, or write the value in the config as literal:<value>.`,
		);
		this.name = "MCPUnresolvedEnvReferenceError";
		this.variable = details.variable;
	}
}

/** What to do with a credential whose refresh threw. `credential` means connect with what is on disk; `failure` means refuse to */
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
