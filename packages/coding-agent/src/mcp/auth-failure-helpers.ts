/** Every reason a configured credential could not be presented. Three states, three different operator actions. `revoked` needs a new */
export const MCP_AUTH_FAILURE_REASONS = ["revoked", "broker-redacted", "store-unavailable"] as const;

export type MCPAuthFailureReason = (typeof MCP_AUTH_FAILURE_REASONS)[number];

/** The refresh token exists but only the auth broker can use it. A class rather than a string test. The previous spelling threw a sentence and */
