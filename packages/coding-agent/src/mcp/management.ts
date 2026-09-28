/**
 * The MCP server management every host runs the same way: testing a
 * connection, detecting and running a server's OAuth login, folding the login
 * back into its config, clearing it, and the Smithery registry's deploy and
 * sign-in steps. A host supplies what it draws (the authorization link, a
 * progress line) and how it cancels; nothing here writes to a screen.
 */

import { setTimeout as sleep } from "node:timers/promises";
import type { AuthStorage } from "@veyyon/ai/auth-storage";
import { errorMessage } from "@veyyon/utils";
import { raceWithTimeout } from "@veyyon/utils/scoped-timeout";
import { expandEnvVarsDeep, unresolvedRefusedDownstream } from "../discovery/env-expansion";
import type { ProviderTextTransformResolver } from "../provider-boundary";
import { connectToServer, disconnectServer, listTools } from "./client";
import { updateMCPServer } from "./config-writer";
import {
	lookupMcpOAuthCredentialForServer,
	mcpOAuthCredentialIdsForServerUrl,
	removeManagedMcpOAuthCredential,
	removeManagedMcpOAuthCredentials,
} from "./oauth-credentials";
import {
	analyzeAuthError,
	discoverOAuthEndpoints,
	fetchResourceMetadataScopes,
	type OAuthEndpoints,
} from "./oauth-discovery";
import { MCPOAuthFlow, type MCPStoredOAuthCredential, mcpOAuthCredentialId } from "./oauth-flow";
import { pollSmitheryCliAuthSession } from "./smithery-auth";
import { searchSmitheryRegistry } from "./smithery-registry";
import type { MCPAuthConfig, MCPServerConfig } from "./types";

/**
 * Resolve a config's auth and `${...}` references into the shape a transport
 * connects with. `MCPManager.prepareConfig` is the implementation every host
 * passes.
 */
export type PrepareMcpConfig = (config: MCPServerConfig, options?: { oauth?: boolean }) => Promise<MCPServerConfig>;

/**
 * Outcome of {@link runMcpOAuthFlow}.
 *
 * `credentialId` is deterministic per server URL when the URL was supplied, so
 * every profile resolves its own credential row under the same id. Refresh
 * material (token URL, client id/secret) is embedded in the stored credential;
 * the returned `clientId` may be folded into `mcp.json` for pre-auth reuse.
 * DCR-issued client secrets stay embedded in the stored credential and are not
 * returned, so they cannot leak into config files.
 */
export interface OAuthFlowResult {
	credentialId: string;
	clientId?: string;
	resource?: string;
}

/**
 * Thrown by {@link runMcpOAuthFlow} when its cancel signal aborts. Distinct
 * from network and timeout failures so a host reports a neutral "cancelled"
 * status instead of an error.
 */
export class MCPOAuthCancelledError extends Error {
	constructor(message = "OAuth flow cancelled") {
		super(message);
		this.name = "MCPOAuthCancelledError";
	}
}

/** How long an OAuth login may wait for the browser before it fails. */
const MCP_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

/** The endpoints and client settings one OAuth login runs against. */
export interface McpOAuthFlowParams {
	authorizationUrl: string;
	tokenUrl: string;
	clientId: string;
	clientSecret: string;
	scopes: string;
	callbackPort?: number;
	callbackPath?: string;
	redirectUri?: string;
	prompt?: string;
	serverUrl?: string;
	registrationUrl?: string;
	resource?: string;
	stripSameOriginResource?: boolean;
}

/** What a host draws and answers while a login runs. */
export interface McpOAuthFlowHooks {
	authStorage: AuthStorage;
	/** Aborting it cancels the login, which then rejects with {@link MCPOAuthCancelledError}. */
	cancel: AbortSignal;
	onAuth(info: { url: string; launchUrl?: string; instructions?: string }): void;
	onProgress?(message: string): void;
	/** The redirect URL or code pasted by hand, for a host whose browser cannot reach the callback. */
	onManualCodeInput?(): Promise<string>;
}

function raceAbortSignal<T>(promise: Promise<T>, signal: AbortSignal, createError: () => Error): Promise<T> {
	if (signal.aborted) return Promise.reject(createError());
	const aborted = Promise.withResolvers<never>();
	const onAbort = (): void => aborted.reject(createError());
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([promise, aborted.promise]).finally(() => {
		signal.removeEventListener("abort", onAbort);
	});
}

function describeOAuthFailure(error: unknown): Error {
	const message = errorMessage(error);
	if (message.includes("timeout") || message.includes("timed out")) {
		return new Error("OAuth flow timed out. Please try again.");
	}
	if (message.includes("403") || message.includes("unauthorized")) {
		return new Error("OAuth authorization failed. Please check your client credentials.");
	}
	if (message.includes("invalid_grant")) {
		return new Error("OAuth authorization code is invalid or expired. Please try again.");
	}
	if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
		return new Error("Could not connect to OAuth server. Please check the URLs and your network connection.");
	}
	return new Error(`OAuth authentication failed: ${message}`);
}

/**
 * Run one OAuth login and store the credential it mints. The login fails after
 * five minutes, and rejects with {@link MCPOAuthCancelledError} once
 * `hooks.cancel` aborts.
 */
export async function runMcpOAuthFlow(params: McpOAuthFlowParams, hooks: McpOAuthFlowHooks): Promise<OAuthFlowResult> {
	let parsedAuthUrl: URL;
	try {
		parsedAuthUrl = new URL(params.authorizationUrl);
		new URL(params.tokenUrl);
	} catch {
		throw new Error(
			`Invalid OAuth URLs. Please check:\n  Authorization URL: ${params.authorizationUrl}\n  Token URL: ${params.tokenUrl}`,
		);
	}
	const clientId = params.clientId.trim() || parsedAuthUrl.searchParams.get("client_id") || undefined;
	const clientSecret = params.clientSecret.trim() || undefined;

	// The cancel signal and the deadline both abort this controller; the flag
	// separates "cancelled" (neutral) from "deadline elapsed" (an error).
	const flowAbort = new AbortController();
	let cancelled = false;
	const onCancel = (): void => {
		cancelled = true;
		if (!flowAbort.signal.aborted) flowAbort.abort(hooks.cancel.reason ?? "MCP OAuth flow cancelled");
	};
	if (hooks.cancel.aborted) onCancel();
	else hooks.cancel.addEventListener("abort", onCancel, { once: true });
	try {
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: params.authorizationUrl,
				tokenUrl: params.tokenUrl,
				registrationUrl: params.registrationUrl,
				clientId,
				clientSecret,
				scopes: params.scopes || undefined,
				prompt: params.prompt,
				redirectUri: params.redirectUri,
				callbackPort: params.callbackPort,
				callbackPath: params.callbackPath,
				resource: params.resource,
				stripSameOriginResource: params.stripSameOriginResource,
			},
			{
				onAuth: info => hooks.onAuth(info),
				onProgress: message => hooks.onProgress?.(message),
				onManualCodeInput: hooks.onManualCodeInput,
				signal: flowAbort.signal,
			},
		);
		const createAbortError = (): Error =>
			cancelled
				? new MCPOAuthCancelledError()
				: new Error(String(flowAbort.signal.reason ?? "MCP OAuth flow aborted"));
		if (flowAbort.signal.aborted) throw createAbortError();

		// Race the login against the abort signal: a cancel may land before the
		// flow reaches the callback server, which is where it observes the signal.
		const credentials = await raceWithTimeout(
			raceAbortSignal(flow.login(), flowAbort.signal, createAbortError),
			MCP_OAUTH_TIMEOUT_MS,
			() => new Error("OAuth flow timed out after 5 minutes"),
			{ onTimeout: async () => flowAbort.abort("MCP OAuth flow timed out") },
		);

		// Deterministic per-URL id: every profile resolves its own credential row
		// under the same key, so shared configs stay profile-isolated. A random id
		// only for a login that never knew the server URL.
		const credentialId = params.serverUrl
			? mcpOAuthCredentialId(params.serverUrl)
			: `mcp_oauth_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
		// Refresh material is embedded so the credential refreshes for a config
		// that carries no auth block at all.
		const stored: MCPStoredOAuthCredential = {
			type: "oauth",
			...credentials,
			tokenUrl: params.tokenUrl,
			clientId: flow.resolvedClientId ?? clientId,
			clientSecret: flow.registeredClientSecret ?? clientSecret,
			resource: flow.resource,
			authorizationUrl: flow.authorizationUrl,
		};
		await hooks.authStorage.set(credentialId, stored);
		return { credentialId, clientId: flow.resolvedClientId, resource: flow.resource };
	} catch (error) {
		if (cancelled) throw new MCPOAuthCancelledError();
		throw describeOAuthFailure(error);
	} finally {
		hooks.cancel.removeEventListener("abort", onCancel);
	}
}

/** A config without its `auth` block, as a login starts from. */
export function stripOAuthAuth(config: MCPServerConfig): MCPServerConfig {
	const next = { ...config } as MCPServerConfig & { auth?: MCPAuthConfig };
	delete next.auth;
	return next;
}

/** The settings a finished login is folded back into a config with. */
export interface OAuthPersistOptions {
	tokenUrl: string;
	resource?: string;
	stripSameOriginResource?: boolean;
	clientId?: string;
	userClientSecret?: string;
}

/**
 * Fold a finished login into a server config: the auth block records the
 * credential pointer and refresh material, the oauth block echoes the client id
 * for reuse before the next login, and only a client secret the operator
 * supplied is written. A secret dynamic registration issued stays in the stored
 * credential, so it cannot reach a shared config file.
 */
export function persistOAuthResult(
	config: MCPServerConfig,
	result: OAuthFlowResult,
	options: OAuthPersistOptions,
): MCPServerConfig {
	const clientId = result.clientId ?? options.clientId ?? config.oauth?.clientId;
	const resource =
		result.resource ?? (options.stripSameOriginResource ? undefined : options.resource) ?? config.auth?.resource;
	return {
		...config,
		auth: {
			type: "oauth",
			credentialId: result.credentialId,
			tokenUrl: options.tokenUrl,
			clientId,
			clientSecret: options.userClientSecret,
			resource,
		},
		oauth: { ...config.oauth, clientId },
	};
}

/** Connect once and disconnect, throwing what the connection threw. */
export async function testMcpConnection(
	prepare: PrepareMcpConfig,
	config: MCPServerConfig,
	options?: { oauth?: boolean },
): Promise<void> {
	const resolved = await prepare(config, options);
	const connection = await connectToServer(`test_${Date.now()}`, resolved);
	await disconnectServer(connection);
}

/** What a one-off connection to a server reported. */
export interface McpProbeResult {
	serverName: string;
	serverVersion: string;
	tools: string[];
}

/**
 * Connect to `name` once, list its tools and disconnect, leaving any running
 * connection to the same server alone.
 */
export async function probeMcpServer(
	prepare: PrepareMcpConfig,
	name: string,
	config: MCPServerConfig,
	signal?: AbortSignal,
): Promise<McpProbeResult> {
	const resolved = await prepare(config);
	const connection = await connectToServer(name, resolved, { signal });
	try {
		const tools = await listTools(connection, { signal });
		return {
			serverName: connection.serverInfo.name,
			serverVersion: connection.serverInfo.version,
			tools: tools.map(tool => tool.name),
		};
	} finally {
		// The outcome does not wait on the transport closing.
		void disconnectServer(connection);
	}
}

/**
 * Read OAuth endpoints out of a refusal. A new server's add swallows a
 * discovery failure and reports the endpoints as undiscoverable; a configured
 * server's reauth reports the discovery failure itself.
 */
async function discoverFromAuthError(
	error: Error,
	config: MCPServerConfig,
	options: { configured: boolean },
): Promise<OAuthEndpoints | null> {
	const url = config.type === "http" || config.type === "sse" ? config.url : undefined;
	const detected = analyzeAuthError(error, url);
	let oauth = detected.authType === "oauth" ? (detected.oauth ?? null) : null;
	if (!oauth && url) {
		const discovery = discoverOAuthEndpoints(url, detected.authServerUrl, detected.resourceMetadataUrl, {
			protectedScopes: detected.scopes,
		});
		oauth = options.configured ? await discovery : await discovery.catch(() => null);
	}
	if (oauth && !oauth.scopes && detected.resourceMetadataUrl) {
		// The JSON-error-body path skips discovery; read the advertised
		// protected-resource metadata for the scopes it requires.
		const scopes = await fetchResourceMetadataScopes(detected.resourceMetadataUrl);
		if (scopes) oauth = { ...oauth, scopes };
	}
	return oauth;
}

/** Whether a new remote server needs a login before it is added. */
export type McpAddAuthProbe =
	| { outcome: "connected" }
	/** The connection failed for a reason other than authentication. */
	| { outcome: "failed"; error: unknown }
	| { outcome: "oauth"; error: unknown; endpoints: OAuthEndpoints }
	/** The server wants authentication and advertises no OAuth endpoints. */
	| { outcome: "undiscoverable"; error: unknown };

/** Connect to a new remote server once and read whether it wants an OAuth login. */
export async function probeMcpAddAuth(prepare: PrepareMcpConfig, config: MCPServerConfig): Promise<McpAddAuthProbe> {
	try {
		await testMcpConnection(prepare, config);
		return { outcome: "connected" };
	} catch (error) {
		const failure = error instanceof Error ? error : new Error(errorMessage(error));
		if (!analyzeAuthError(failure, "url" in config ? config.url : undefined).requiresAuth) {
			return { outcome: "failed", error };
		}
		const endpoints = await discoverFromAuthError(failure, config, { configured: false });
		return endpoints ? { outcome: "oauth", error, endpoints } : { outcome: "undiscoverable", error };
	}
}

/** A login ready to run, and how its result is written back. */
export interface McpOAuthPlan {
	flow: McpOAuthFlowParams;
	persist: OAuthPersistOptions;
}

/** The login a new remote server's advertised endpoints call for. */
export function planMcpAddOAuth(endpoints: OAuthEndpoints, config: MCPServerConfig): McpOAuthPlan {
	const url = "url" in config ? config.url : undefined;
	const resource = endpoints.resource ?? url;
	const stripSameOriginResource = !endpoints.resource;
	return {
		flow: {
			authorizationUrl: endpoints.authorizationUrl,
			tokenUrl: endpoints.tokenUrl,
			clientId: endpoints.clientId ?? config.oauth?.clientId ?? "",
			clientSecret: config.oauth?.clientSecret ?? "",
			scopes: endpoints.scopes ?? "",
			callbackPort: config.oauth?.callbackPort,
			callbackPath: config.oauth?.callbackPath,
			redirectUri: config.oauth?.redirectUri,
			prompt: config.oauth?.prompt,
			registrationUrl: endpoints.registrationUrl,
			serverUrl: url,
			resource,
			stripSameOriginResource,
		},
		persist: {
			tokenUrl: endpoints.tokenUrl,
			resource,
			stripSameOriginResource,
			clientId: endpoints.clientId,
			userClientSecret: config.oauth?.clientSecret,
		},
	};
}

/**
 * Read a configured server's OAuth endpoints from its refusal. Fails for a
 * stdio server, which keeps its own credentials, and for a server that
 * connects without a login.
 */
export async function resolveMcpOAuthEndpoints(
	prepare: PrepareMcpConfig,
	config: MCPServerConfig,
): Promise<OAuthEndpoints> {
	// Only http and sse transports log in through this flow. Probing a stdio
	// server spawns the child, which reuses its own cached tokens (such as
	// mcp-remote's machine-wide ~/.mcp-auth) and reports that no login is needed.
	if (config.type !== "http" && config.type !== "sse") {
		const remoteUrl = config.args?.find(arg => /^https?:\/\//.test(arg));
		const httpHint = `{ "type": "http", "url": ${JSON.stringify(remoteUrl ?? "<remote url>")} }`;
		const usesMcpRemote = [config.command, ...(config.args ?? [])].some(part => part?.includes("mcp-remote"));
		throw new Error(
			usesMcpRemote
				? `this server proxies OAuth through mcp-remote, which caches tokens machine-wide in ~/.mcp-auth (shared across every Veyyon profile). Clear ~/.mcp-auth to force a fresh login, or replace the proxy with ${httpHint} so Veyyon manages OAuth per profile.`
				: `stdio servers manage their own credentials, so Veyyon has no OAuth to reauthorize. If the service supports OAuth over HTTP, configure it as ${httpHint} instead.`,
		);
	}
	let refusal: Error | undefined;
	try {
		await testMcpConnection(prepare, stripOAuthAuth(config), { oauth: false });
	} catch (error) {
		refusal = error instanceof Error ? error : new Error(errorMessage(error));
	}
	if (!refusal) throw new Error("Server connection succeeded without OAuth; reauthorization is not required.");
	// A configured server is logged in again even when its refusal carries no
	// auth signal, and a discovery failure is the error reported.
	const oauth = await discoverFromAuthError(refusal, config, { configured: true });
	if (!oauth) throw new Error("Could not discover OAuth endpoints from server response.");
	return oauth;
}

/** A configured server's next login, and what it replaces. */
export interface McpReauthPlan extends McpOAuthPlan {
	/** The config without its auth block, which the result is folded into. */
	baseConfig: MCPServerConfig;
	/** The auth block the config held before the login. */
	previousAuth?: MCPAuthConfig;
}

/**
 * Plan a configured server's login again. Nothing is changed until the plan
 * is committed, so a login that fails or is cancelled leaves the previous one
 * signed in.
 */
export async function planMcpReauth(
	prepare: PrepareMcpConfig,
	authStorage: AuthStorage,
	config: MCPServerConfig,
): Promise<McpReauthPlan> {
	const previousAuth = (config as MCPServerConfig & { auth?: MCPAuthConfig }).auth;
	const baseConfig = stripOAuthAuth(config);
	// The connect guard names an unresolved field and its variable in the
	// refusal the operator reads, so reporting it here would say it twice.
	const refusedAtConnect = unresolvedRefusedDownstream(
		"the MCP connect guard refuses an unresolved structural field before a transport exists",
	);
	// Discovery connects with the env-expanded shape runtime discovery passes to
	// the manager; the file value may hold `${...}` placeholders.
	const runtimeConfig = expandEnvVarsDeep(baseConfig, refusedAtConnect);
	const oauth = await resolveMcpOAuthEndpoints(prepare, runtimeConfig);
	const serverUrl = runtimeConfig.type === "http" || runtimeConfig.type === "sse" ? runtimeConfig.url : undefined;
	// An operator-supplied client secret may sit in either block; a secret
	// dynamic registration issued is embedded in the stored credential.
	const configuredClientId = config.oauth?.clientId ?? previousAuth?.clientId;
	const existing = lookupMcpOAuthCredentialForServer(authStorage, previousAuth, serverUrl)?.credential;
	const clientId = oauth.clientId ?? configuredClientId ?? existing?.clientId ?? "";
	const storedClientSecret = existing?.clientId === clientId ? existing.clientSecret : undefined;
	const userClientSecret = config.oauth?.clientSecret ?? previousAuth?.clientSecret;
	const previousResource = previousAuth?.resource
		? expandEnvVarsDeep(previousAuth.resource, refusedAtConnect)
		: undefined;
	const resource = oauth.resource ?? previousResource ?? ("url" in runtimeConfig ? runtimeConfig.url : undefined);
	const stripSameOriginResource = !oauth.resource && !previousResource;
	return {
		baseConfig,
		previousAuth,
		flow: {
			authorizationUrl: oauth.authorizationUrl,
			tokenUrl: oauth.tokenUrl,
			clientId,
			clientSecret: userClientSecret ?? storedClientSecret ?? "",
			scopes: oauth.scopes ?? "",
			callbackPort: config.oauth?.callbackPort,
			callbackPath: config.oauth?.callbackPath,
			redirectUri: config.oauth?.redirectUri,
			prompt: config.oauth?.prompt,
			registrationUrl: oauth.registrationUrl,
			serverUrl,
			resource,
			stripSameOriginResource,
		},
		persist: {
			tokenUrl: oauth.tokenUrl,
			clientId: oauth.clientId,
			userClientSecret,
			resource,
			stripSameOriginResource,
		},
	};
}

/**
 * Commit a finished login: drop the credential it superseded, and write the
 * auth block into `filePath` unless the server resolves through its
 * URL-keyed credential alone.
 */
export async function commitMcpReauth(
	plan: McpReauthPlan,
	result: OAuthFlowResult,
	authStorage: AuthStorage,
	filePath: string,
	name: string,
): Promise<void> {
	const previous = plan.previousAuth;
	if (previous?.type === "oauth" && previous.credentialId !== result.credentialId) {
		await removeManagedMcpOAuthCredential(authStorage, previous.credentialId);
	}
	// A definition-only entry resolves through the URL-keyed credential, so the
	// config is left as it was.
	const urlKeyedId = plan.flow.serverUrl ? mcpOAuthCredentialId(plan.flow.serverUrl) : undefined;
	if (previous || result.credentialId !== urlKeyedId) {
		await updateMCPServer(filePath, name, persistOAuthResult(plan.baseConfig, result, plan.persist));
	}
}

/**
 * Delete a server's stored OAuth credentials, and the `auth` block pointing at
 * them from `filePath`. Returns false when there was nothing to delete.
 *
 * A discovered server's config is another tool's file and is never written;
 * only its credentials are deleted.
 */
export async function clearMcpServerAuth(
	authStorage: AuthStorage,
	server: { config: MCPServerConfig; discovered: boolean },
	filePath: string,
	name: string,
): Promise<boolean> {
	const auth = (server.config as MCPServerConfig & { auth?: MCPAuthConfig }).auth;
	if (auth?.type === "oauth") await removeManagedMcpOAuthCredential(authStorage, auth.credentialId);
	// The URL-keyed row signs a server in even when its config holds no auth
	// block. Runtime discovery expands `${...}` in the URL before the manager
	// looks the row up, so the same expanded key is deleted.
	let removedUrlKeyed = false;
	if ((server.config.type === "http" || server.config.type === "sse") && server.config.url) {
		removedUrlKeyed = await removeManagedMcpOAuthCredentials(
			authStorage,
			mcpOAuthCredentialIdsForServerUrl(server.config.url),
		);
	}
	if (server.discovered && auth?.type !== "oauth") return removedUrlKeyed;
	await updateMCPServer(filePath, name, stripOAuthAuth(server.config));
	return true;
}

/** Write a registry server's input values into its launch arguments. */
export function applyRegistryInputOverrides(config: MCPServerConfig, values: Record<string, string>): MCPServerConfig {
	if (Object.keys(values).length === 0 || config.type !== "stdio") return config;
	const args = [...(config.args ?? [])];
	const configJson = JSON.stringify(values);
	const index = args.indexOf("--config");
	if (index < 0) args.push("--config", configJson);
	else if (index + 1 < args.length) args[index + 1] = configJson;
	else args.push(configJson);
	return { ...config, args };
}

/**
 * `baseName`, or the first `baseName-N` not in `taken`. A registry search
 * suggests a name per result, so the caller reads the config once and passes
 * the names it holds.
 */
export function nextAvailableServerName(taken: ReadonlySet<string>, baseName: string): string {
	if (!taken.has(baseName)) return baseName;
	for (let i = 2; i <= 999; i++) {
		const candidate = `${baseName}-${i}`;
		if (!taken.has(candidate)) return candidate;
	}
	return `${baseName}-${Date.now()}`;
}

/** Check a Smithery API key by running one registry search with it. */
export async function validateSmitheryApiKey(
	apiKey: string,
	resolveProviderTextTransform?: ProviderTextTransformResolver,
): Promise<void> {
	await searchSmitheryRegistry("mcp", { limit: 1, apiKey, resolveProviderTextTransform });
}

const SMITHERY_POLL_INTERVAL_MS = 2_000;
const SMITHERY_LOGIN_TIMEOUT_MS = 300_000;

/**
 * Poll a Smithery CLI login session until the browser step mints a key. Fails
 * after five minutes, and once `signal` aborts.
 */
export async function waitForSmitheryCliApiKey(sessionId: string, signal: AbortSignal): Promise<string> {
	const startedAt = Date.now();
	while (!signal.aborted) {
		if (Date.now() - startedAt >= SMITHERY_LOGIN_TIMEOUT_MS) {
			throw new Error("Smithery authorization timed out after 5 minutes.");
		}
		const response = await pollSmitheryCliAuthSession(sessionId, signal);
		if (response.status === "success" && response.apiKey) return response.apiKey;
		if (response.status === "error") throw new Error(response.message ?? "Smithery authorization failed.");
		try {
			await sleep(SMITHERY_POLL_INTERVAL_MS, undefined, { signal });
		} catch {
			break;
		}
	}
	throw new Error("Smithery authorization cancelled.");
}
