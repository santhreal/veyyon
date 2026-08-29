import type { OAuthCallbackFlowOptions } from "@veyyon/ai/oauth/callback-server";
import { DEFAULT_CALLBACK_PATH } from "@veyyon/ai/oauth/callback-server";
import type { FetchImpl } from "@veyyon/ai/types";
import { truncate } from "@veyyon/utils";
import { getActiveProfile } from "@veyyon/utils/dirs";
import type { OAuthCredential } from "../session/auth-storage";

export const MCP_OAUTH_URL_CREDENTIAL_PREFIX = "mcp_oauth:";

export const MCP_OAUTH_PROFILE_CREDENTIAL_PREFIX = `${MCP_OAUTH_URL_CREDENTIAL_PREFIX}profile:`;

export function mcpOAuthCredentialId(serverUrl: string, profile: string | undefined = getActiveProfile()): string {
	return `${MCP_OAUTH_PROFILE_CREDENTIAL_PREFIX}${profile ?? "default"}:${serverUrl}`;
}

export function isManagedMCPOAuthCredentialId(credentialId: string | undefined): credentialId is string {
	return (
		!!credentialId &&
		(credentialId.startsWith("mcp_oauth_") || credentialId.startsWith(MCP_OAUTH_URL_CREDENTIAL_PREFIX))
	);
}

export function mcpOAuthCredentialProfile(credentialId: string): string | undefined {
	if (!credentialId.startsWith(MCP_OAUTH_PROFILE_CREDENTIAL_PREFIX)) return undefined;
	const separator = credentialId.indexOf(":", MCP_OAUTH_PROFILE_CREDENTIAL_PREFIX.length);
	return separator === -1 ? undefined : credentialId.slice(MCP_OAUTH_PROFILE_CREDENTIAL_PREFIX.length, separator);
}

export interface MCPStoredOAuthCredential extends OAuthCredential {
	tokenUrl?: string;
	clientId?: string;
	clientSecret?: string;
	resource?: string;
	authorizationUrl?: string;
}

export const DEFAULT_PORT = 3000;

export function hasOAuthScope(scopes: string | null | undefined, scope: string): boolean {
	return !!scopes && scopes.split(/\s+/).includes(scope);
}

export function truncateDetail(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const firstLine = raw.split(/\r?\n/, 1)[0]?.trim();
	if (!firstLine) return undefined;
	return truncate(firstLine, 200);
}

export async function readRegistrationFailureDetail(response: Response): Promise<string | undefined> {
	try {
		return truncateDetail(await response.text());
	} catch {
		return undefined;
	}
}

export function isLoopbackHostname(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1";
}

export function resolveRedirectUri(redirectUri: string | undefined): string | undefined {
	const configured = redirectUri;
	const trimmed = configured?.trim();
	if (!trimmed) return undefined;
	if (trimmed !== configured) {
		throw new Error(
			`The \`oauth.redirectUri\` "${configured}" has leading or trailing whitespace, which an authorization server compares literally and will reject as a redirect_uri mismatch. Fix: remove the whitespace from \`oauth.redirectUri\` on this server's entry in your MCP config.`,
		);
	}

	const parsed = new URL(configured);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(
			`The \`oauth.redirectUri\` "${configured}" uses the "${parsed.protocol}" scheme, and an OAuth redirect must be http or https. Fix: change \`oauth.redirectUri\` on this server's entry in your MCP config to an \`http://localhost:<port>/…\` loopback URL, or delete it to use the default.`,
		);
	}
	return configured;
}

export function parseRedirectUri(redirectUri: string | undefined): URL | undefined {
	return redirectUri ? new URL(redirectUri) : undefined;
}

export function getUriPort(uri: URL): number {
	if (uri.port !== "") return Number(uri.port);
	return uri.protocol === "https:" ? 443 : 80;
}

export function validateRedirectConfig(config: MCPOAuthConfig, redirectUri: string | undefined): void {
	const parsed = parseRedirectUri(redirectUri);
	if (parsed?.protocol !== "https:" || !isLoopbackHostname(parsed.hostname)) {
		return;
	}

	if (config.callbackPort === undefined) {
		throw new Error(
			`The \`oauth.redirectUri\` "${redirectUri}" is an HTTPS loopback URL, and the local callback listener speaks plain HTTP: it terminates no TLS. Fix: set \`oauth.callbackPort\` on this server's entry in your MCP config to the plain-HTTP port your TLS terminator forwards to.`,
		);
	}

	if (config.callbackPort === getUriPort(parsed)) {
		throw new Error(
			`\`oauth.callbackPort\` is ${config.callbackPort}, the same port as the HTTPS redirect URI "${redirectUri}", so the local listener would collide with the TLS terminator. Fix: give \`oauth.callbackPort\` a different, plain-HTTP port on this server's entry in your MCP config and forward ${getUriPort(parsed)} to it.`,
		);
	}
}

export function resolveCallbackPort(callbackPort: number | undefined, redirectUri: string | undefined): number {
	if (callbackPort !== undefined) return callbackPort;

	const parsed = parseRedirectUri(redirectUri);
	if (parsed?.protocol !== "http:" || !isLoopbackHostname(parsed.hostname)) {
		return DEFAULT_PORT;
	}

	const port = getUriPort(parsed);
	return Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT;
}

export function resolveCallbackPath(callbackPath: string | undefined, redirectUri: string | undefined): string {
	const trimmed = callbackPath?.trim();
	if (trimmed) return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;

	const parsed = parseRedirectUri(redirectUri);
	if (parsed?.pathname) return parsed.pathname;
	return DEFAULT_CALLBACK_PATH;
}

export function resolveCallbackHostname(redirectUri: string | undefined): string | undefined {
	const parsed = parseRedirectUri(redirectUri);
	if (!parsed || !isLoopbackHostname(parsed.hostname)) return undefined;
	return parsed.hostname;
}

export function staticClientIdFromConfig(config: MCPOAuthConfig): string | undefined {
	const fromConfig = config.clientId?.trim();
	if (fromConfig) return fromConfig;
	try {
		return new URL(config.authorizationUrl).searchParams.get("client_id") ?? undefined;
	} catch {
		return undefined;
	}
}

export function resolveCallbackOptions(config: MCPOAuthConfig): OAuthCallbackFlowOptions {
	const redirectUri = resolveRedirectUri(config.redirectUri);
	validateRedirectConfig(config, redirectUri);
	const allowPortFallback = staticClientIdFromConfig(config) === undefined;
	return {
		preferredPort: resolveCallbackPort(config.callbackPort, redirectUri),
		callbackPath: resolveCallbackPath(config.callbackPath, redirectUri),
		callbackHostname: resolveCallbackHostname(redirectUri),
		redirectUri,
		allowPortFallback,
	};
}

export function resolveResourceUri(resource: string | undefined): string | undefined {
	const trimmed = resource?.trim();
	if (!trimmed) return undefined;
	if (trimmed !== resource) {
		throw new Error(
			`The \`auth.resource\` "${resource}" has leading or trailing whitespace, which an authorization server compares literally and will reject. Fix: remove the whitespace from \`auth.resource\` on this server's entry in your MCP config.`,
		);
	}

	const parsed = new URL(trimmed);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(
			`The \`auth.resource\` "${trimmed}" uses the "${parsed.protocol}" scheme, and an RFC 8707 resource indicator must be http or https. Fix: change \`auth.resource\` on this server's entry in your MCP config, or delete it to let the server URL be used.`,
		);
	}
	if (parsed.hash) {
		throw new Error(
			`The \`auth.resource\` "${trimmed}" includes the fragment "${parsed.hash}", which RFC 8707 forbids in a resource indicator. Fix: drop everything from the "#" onward in \`auth.resource\` on this server's entry in your MCP config.`,
		);
	}
	return trimmed;
}

export interface ResourceIndicatorFilterOptions {
	stripSameOriginResource?: boolean;
}

export function filterResourceIndicator(
	resource: string | undefined,
	serverUrl: string,
	options: ResourceIndicatorFilterOptions = {},
): string | undefined {
	if (!resource) return undefined;
	try {
		const origin = new URL(serverUrl).origin;
		const parsedResource = new URL(resource);
		if (parsedResource.origin !== origin) return resource;
		if (options.stripSameOriginResource) return undefined;
	} catch {}
	return resource;
}

export interface MCPOAuthConfig {
	authorizationUrl: string;
	tokenUrl: string;
	registrationUrl?: string;
	clientId?: string;
	clientSecret?: string;
	scopes?: string;
	prompt?: string;
	redirectUri?: string;
	callbackPort?: number;
	callbackPath?: string;
	resource?: string;
	stripSameOriginResource?: boolean;
	fetch?: FetchImpl;
}
