/**
 * MCP OAuth lane for the /mcp command controller: browser/manual OAuth flow
 * execution, endpoint discovery from a failing connection, credential
 * persistence policy, and the width-aware authorization-URL prompt.
 */
import { type Component, replaceTabs, Spacer, Text } from "@veyyon/pi-tui";
import { getProjectDir } from "@veyyon/pi-utils";
import {
	analyzeAuthError,
	discoverOAuthEndpoints,
	fetchResourceMetadataScopes,
	MCPManager,
	type OAuthEndpoints,
} from "../../mcp";
import { connectToServer, disconnectServer } from "../../mcp/client";
import { MCPOAuthFlow, type MCPStoredOAuthCredential, mcpOAuthCredentialId } from "../../mcp/oauth-flow";
import type { MCPAuthConfig, MCPServerConfig } from "../../mcp/types";
import { urlHyperlinkAlways } from "../../tui";
import { copyToClipboard } from "../../utils/clipboard";
import { openPath } from "../../utils/open";
import { TranscriptBlock } from "../components/transcript-container";
import { theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";

const MCP_MANUAL_INPUT_PROVIDER_ID = "mcp";
const MCP_MANUAL_LOGIN_TIP = "Headless? Paste the redirect URL or code with /login <value>.";

export function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	message: string,
	onTimeout?: () => void,
): Promise<T> {
	const { promise: timeoutPromise, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => {
		onTimeout?.();
		reject(new Error(message));
	}, timeoutMs);
	return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
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

/**
 * Minimum column budget for URL wrapping. Below this the terminal is
 * effectively unusable, but we still emit chunks so no character is silently
 * dropped and the user can widen and reflow.
 */
const MCP_AUTH_MIN_WRAP_WIDTH = 16;

/**
 * Wrap `url` into rows that each fit inside `width`. When the label + URL fit
 * on one line, returns a single indented row; otherwise puts the label on its
 * own indented row and slices the URL into fixed-width chunks that start at
 * column 0. Continuation chunks carry ZERO leading bytes on purpose: a
 * multi-row terminal selection includes the newline plus any leading indent,
 * and while address bars strip newlines they preserve or percent-encode
 * embedded spaces — an indent would corrupt the URL at every chunk boundary
 * (silently, when the damage lands inside a query value).
 */
function wrapUrlRows(label: string, url: string, width: number): string[] {
	const indent = " ";
	const sanitized = replaceTabs(url);
	const effective = Math.max(MCP_AUTH_MIN_WRAP_WIDTH, Math.trunc(width));
	const inlineWidth = indent.length + label.length + 1 + sanitized.length;
	if (inlineWidth <= effective) {
		return [`${indent}${theme.fg("muted", `${label} ${sanitized}`)}`];
	}
	const rows: string[] = [`${indent}${theme.fg("muted", label)}`];
	for (let i = 0; i < sanitized.length; i += effective) {
		rows.push(theme.fg("muted", sanitized.slice(i, i + effective)));
	}
	return rows;
}

/**
 * Renders the MCP OAuth fallback URL. Always shows the full authorization URL
 * as the primary `Copy URL:` target — that works from any machine, including
 * SSH/WSL/headless sessions where the OMP-hosted `/launch` loopback URL would
 * resolve against the user's local browser and fail.
 *
 * The render is `width`-aware: on any viewport narrower than the composed row
 * ({@link TUI#prepareLine} truncates anything wider with `Ellipsis.Omit`, no
 * marker), the URL is hard-wrapped into width-fitted rows so the primary copy
 * target can never silently lose trailing OAuth parameters — the failure mode
 * that motivated #4418 in the first place. Browsers strip whitespace when a
 * multi-row selection is pasted into the address bar, so the reassembled URL
 * is byte-identical to what we rendered.
 *
 * When the flow's callback server hosts a short `launchUrl`, it is offered
 * as an additional local shortcut for wide-terminal local users. The OSC 8
 * hyperlink continues to carry the full URL for terminals that support it.
 */
export class MCPAuthorizationLinkPrompt implements Component {
	readonly #fullUrl: string;
	readonly #launchUrl: string | undefined;

	constructor(url: string, launchUrl?: string) {
		this.#fullUrl = url;
		this.#launchUrl = launchUrl && launchUrl !== url ? launchUrl : undefined;
	}

	invalidate(): void {}

	render(width: number): readonly string[] {
		const link = urlHyperlinkAlways(this.#fullUrl, "Click here to authorize");
		const lines: string[] = [
			` ${theme.fg("success", "Open authorization URL:")}`,
			` ${theme.fg("accent", link)}`,
			...wrapUrlRows("Copy URL:", this.#fullUrl, width),
		];
		if (this.#launchUrl) {
			lines.push(...wrapUrlRows("Local shortcut (this machine only):", this.#launchUrl, width));
		}
		return lines;
	}
}

/**
 * Outcome of {@link runMcpOAuthFlow}.
 *
 * `credentialId` is deterministic per server URL when the URL was supplied, so
 * every profile resolves its own credential row under the same id. Refresh
 * material (token URL, client id/secret) is embedded in the stored credential;
 * the returned `clientId` may be folded into `mcp.json` for pre-auth reuse.
 * DCR-issued client secrets stay embedded in the stored credential and are
 * deliberately not surfaced here, so they cannot leak into config files.
 */
export interface OAuthFlowResult {
	credentialId: string;
	clientId?: string;
	resource?: string;
}

/**
 * Thrown by {@link runMcpOAuthFlow} when the user (or a caller-supplied
 * {@link AbortSignal}) cancels the in-flight flow. Distinct from
 * network/timeout failures so callers can surface a neutral
 * "cancelled" status instead of an error banner.
 */
export class MCPOAuthCancelledError extends Error {
	constructor(message = "OAuth flow cancelled") {
		super(message);
		this.name = "MCPOAuthCancelledError";
	}
}

/** Reason recorded on the OAuth flow's AbortController when the user hits Esc. */
const MCP_OAUTH_USER_CANCEL_REASON = "MCP OAuth flow cancelled by user";

/** Handle the interactive OAuth authentication flow for an MCP server. */
export async function runMcpOAuthFlow(
	ctx: InteractiveModeContext,
	authUrl: string,
	tokenUrl: string,
	clientId: string,
	clientSecret: string,
	scopes: string,
	opts?: {
		callbackPort?: number;
		callbackPath?: string;
		redirectUri?: string;
		prompt?: string;
		serverUrl?: string;
		registrationUrl?: string;
		resource?: string;
		stripSameOriginResource?: boolean;
		/**
		 * External cancellation source: when this signal aborts, the in-flight
		 * OAuth flow is torn down and {@link MCPOAuthCancelledError} is thrown.
		 * Wizards (which own focus and absorb Esc themselves) pass their own
		 * controller here; editor-focused callers rely on the Esc hook
		 * installed below instead.
		 */
		abortSignal?: AbortSignal;
	},
): Promise<OAuthFlowResult> {
	const authStorage = ctx.session.modelRegistry.authStorage;
	let parsedAuthUrl: URL;

	// Validate OAuth URLs
	try {
		parsedAuthUrl = new URL(authUrl);
		new URL(tokenUrl);
	} catch (_error) {
		throw new Error(`Invalid OAuth URLs. Please check:\n  Authorization URL: ${authUrl}\n  Token URL: ${tokenUrl}`);
	}

	const resolvedClientId = clientId.trim() || parsedAuthUrl.searchParams.get("client_id") || undefined;
	const resolvedClientSecret = clientSecret.trim() || undefined;

	const manualInput = ctx.oauthManualInput;
	if (manualInput.hasPending()) {
		const pendingProvider = manualInput.pendingProviderId ?? "another provider";
		throw new Error(
			`OAuth login already in progress for ${pendingProvider}. Complete or cancel it before starting MCP OAuth.`,
		);
	}
	let manualInputClaim: { promise: Promise<string>; clear: (reason?: string) => void } | undefined;
	const oauthTimeout = new AbortController();
	// User Esc and external aborts route through here; the timeout path sets
	// its own reason and leaves this flag false so the catch can distinguish
	// "user cancelled" (status) from "deadline elapsed" (error).
	let userCancelled = false;
	const requestUserCancel = (reason: string): void => {
		userCancelled = true;
		if (!oauthTimeout.signal.aborted) oauthTimeout.abort(reason);
	};
	const originalOnEscape = ctx.editor.onEscape;
	ctx.editor.onEscape = () => requestUserCancel(MCP_OAUTH_USER_CANCEL_REASON);
	const externalSignal = opts?.abortSignal;
	const onExternalAbort = (): void => {
		const reason = externalSignal?.reason;
		requestUserCancel(typeof reason === "string" ? reason : MCP_OAUTH_USER_CANCEL_REASON);
	};
	if (externalSignal?.aborted) {
		onExternalAbort();
	} else {
		externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
	}
	try {
		// Create OAuth flow
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: authUrl,
				tokenUrl: tokenUrl,
				registrationUrl: opts?.registrationUrl,
				clientId: resolvedClientId,
				clientSecret: resolvedClientSecret,
				scopes: scopes || undefined,
				prompt: opts?.prompt,
				redirectUri: opts?.redirectUri,
				callbackPort: opts?.callbackPort,
				callbackPath: opts?.callbackPath,
				resource: opts?.resource,
				stripSameOriginResource: opts?.stripSameOriginResource,
			},
			{
				onAuth: (info: { url: string; launchUrl?: string; instructions?: string }) => {
					// Show auth URL prominently in chat as one block
					const block = new TranscriptBlock();
					ctx.present(block);
					block.addChild(new Text(theme.fg("accent", "━━━ OAuth Authorization Required ━━━"), 1, 0));
					block.addChild(new Spacer(1));
					block.addChild(new Text(theme.fg("muted", "Preparing browser authorization..."), 1, 0));
					block.addChild(new Spacer(1));
					block.addChild(
						new Text(
							theme.fg("muted", "Waiting for authorization... (Press Esc to cancel, 5 minute timeout)"),
							1,
							0,
						),
					);
					block.addChild(new Text(theme.fg("muted", MCP_MANUAL_LOGIN_TIP), 1, 0));
					block.addChild(new Spacer(1));
					block.addChild(new Text(theme.fg("accent", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"), 1, 0));
					// `openPath` is best-effort — it logs spawn failures but never
					// throws, so we always render the copy-URL fallback beneath the
					// "attempting to open browser" line and no earlier try/catch is
					// worth keeping.
					openPath(info.url);
					// Stage the FULL authorization URL on the clipboard via OSC 52.
					// The full URL works from any machine (unlike `launchUrl`, which
					// only resolves against the OMP host), and OSC 52 is a
					// wire-level protocol — the terminal writes it to the user's
					// LOCAL clipboard even when OMP is on a remote SSH box.
					// Best-effort: falls back to the visible copy-URL rows below
					// whether or not the terminal honors OSC 52.
					void copyToClipboard(info.url).catch(() => {});
					block.addChild(new Spacer(1));
					block.addChild(new Text(theme.fg("success", "→ Attempting to open browser..."), 1, 0));
					block.addChild(new Spacer(1));
					block.addChild(new Text(theme.fg("muted", "Alternative if browser did not open:"), 1, 0));
					block.addChild(new MCPAuthorizationLinkPrompt(info.url, info.launchUrl));
					ctx.ui.requestRender();
				},
				onProgress: (message: string) => {
					ctx.present([new Spacer(1), new Text(theme.fg("muted", message), 1, 0)]);
				},
				onManualCodeInput: () => {
					if (manualInputClaim) return manualInputClaim.promise;
					const pendingInput = manualInput.tryClaimInput(MCP_MANUAL_INPUT_PROVIDER_ID);
					if (!pendingInput) {
						const pendingProvider = manualInput.pendingProviderId ?? "another provider";
						throw new Error(
							`OAuth login already in progress for ${pendingProvider}. Complete or cancel it before starting MCP OAuth.`,
						);
					}
					manualInputClaim = pendingInput;
					return pendingInput.promise;
				},
				signal: oauthTimeout.signal,
			},
		);

		const createAbortError = (): Error => {
			const reason = String(oauthTimeout.signal.reason ?? "MCP OAuth flow aborted");
			return userCancelled ? new MCPOAuthCancelledError() : new Error(reason);
		};
		if (oauthTimeout.signal.aborted) throw createAbortError();

		// Execute OAuth flow with 5 minute timeout. Race the login itself
		// against the abort signal because Esc/external abort may fire before
		// MCPOAuthFlow reaches OAuthCallbackFlow.#waitForCallback, where the
		// underlying callback server normally observes the signal.
		const credentials = await withTimeout(
			raceAbortSignal(flow.login(), oauthTimeout.signal, createAbortError),
			5 * 60 * 1000,
			"OAuth flow timed out after 5 minutes",
			() => oauthTimeout.abort("MCP OAuth flow timed out"),
		);

		ctx.present([new Spacer(1), new Text(theme.fg("success", "ok Authorization completed in browser."), 1, 0)]);

		// Deterministic per-URL id: every profile resolves its own credential row
		// under the same key, so shared project configs stay profile-isolated.
		// Random fallback only for flows that never knew the server URL.
		const credentialId = opts?.serverUrl
			? mcpOAuthCredentialId(opts.serverUrl)
			: `mcp_oauth_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

		// Embed refresh material so the credential is self-contained: token
		// refresh must work for configs that carry no auth block at all.
		const oauthCredential: MCPStoredOAuthCredential = {
			type: "oauth",
			...credentials,
			tokenUrl,
			clientId: flow.resolvedClientId ?? resolvedClientId,
			clientSecret: flow.registeredClientSecret ?? resolvedClientSecret,
			resource: flow.resource,
			authorizationUrl: flow.authorizationUrl,
		};

		await authStorage.set(credentialId, oauthCredential);

		return {
			credentialId,
			clientId: flow.resolvedClientId,
			resource: flow.resource,
		};
	} catch (error) {
		// User-initiated cancel (Esc or external signal) → neutral status, not
		// a failure. Check the flag we set in `requestUserCancel`, not the
		// abort reason: the timeout path also aborts but with a different
		// reason, and we want it to surface as a timeout error below.
		if (userCancelled) {
			throw new MCPOAuthCancelledError();
		}

		const errorMsg = error instanceof Error ? error.message : String(error);

		// Provide helpful error messages based on failure type
		if (errorMsg.includes("timeout") || errorMsg.includes("timed out")) {
			throw new Error("OAuth flow timed out. Please try again.");
		} else if (errorMsg.includes("403") || errorMsg.includes("unauthorized")) {
			throw new Error("OAuth authorization failed. Please check your client credentials.");
		} else if (errorMsg.includes("invalid_grant")) {
			throw new Error("OAuth authorization code is invalid or expired. Please try again.");
		} else if (errorMsg.includes("ECONNREFUSED") || errorMsg.includes("fetch failed")) {
			throw new Error("Could not connect to OAuth server. Please check the URLs and your network connection.");
		} else {
			throw new Error(`OAuth authentication failed: ${errorMsg}`);
		}
	} finally {
		ctx.editor.onEscape = originalOnEscape;
		externalSignal?.removeEventListener("abort", onExternalAbort);
		manualInputClaim?.clear("Manual MCP OAuth input cleared");
	}
}

/**
 * Fold a completed OAuth flow back into a server config. Owns the
 * persistence policy in one place: the auth block records the credential
 * pointer plus refresh material, the oauth block echoes the client id for
 * pre-auth reuse, and only a user-supplied client secret is ever written —
 * DCR-issued secrets stay embedded in the stored credential so they cannot
 * leak into (possibly shared/committed) config files.
 */
export function persistOAuthResult(
	config: MCPServerConfig,
	result: OAuthFlowResult,
	opts: {
		tokenUrl: string;
		resource?: string;
		stripSameOriginResource?: boolean;
		clientId?: string;
		userClientSecret?: string;
	},
): MCPServerConfig {
	const clientId = result.clientId ?? opts.clientId ?? config.oauth?.clientId;
	const resource =
		result.resource ?? (opts.stripSameOriginResource ? undefined : opts.resource) ?? config.auth?.resource;
	return {
		...config,
		auth: {
			type: "oauth",
			credentialId: result.credentialId,
			tokenUrl: opts.tokenUrl,
			clientId,
			clientSecret: opts.userClientSecret,
			resource,
		},
		oauth: {
			...config.oauth,
			clientId,
		},
	};
}

/**
 * Test connection to an MCP server.
 * Throws an error if connection fails (used for auto-detection).
 */
export async function testMcpConnection(
	ctx: InteractiveModeContext,
	config: MCPServerConfig,
	options?: { oauth?: boolean },
): Promise<void> {
	// Create temporary connection using a test name
	const testName = `test_${Date.now()}`;
	let resolvedConfig: MCPServerConfig;
	if (ctx.mcpManager) {
		resolvedConfig = await ctx.mcpManager.prepareConfig(config, options);
	} else {
		const tempManager = new MCPManager(getProjectDir());
		tempManager.setAuthStorage(ctx.session.modelRegistry.authStorage);
		resolvedConfig = await tempManager.prepareConfig(config, options);
	}

	const connection = await connectToServer(testName, resolvedConfig);
	await disconnectServer(connection);
}

export function stripOAuthAuth(config: MCPServerConfig): MCPServerConfig {
	const next = { ...config } as MCPServerConfig & { auth?: MCPAuthConfig };
	delete next.auth;
	return next;
}

export async function resolveOAuthEndpointsFromServer(
	ctx: InteractiveModeContext,
	config: MCPServerConfig,
): Promise<OAuthEndpoints> {
	// Stdio servers manage credentials inside the child process; OMP's OAuth
	// flow only applies to http/sse transports. Without this guard the
	// unauthenticated preflight below spawns the child, which happily reuses
	// its own cached tokens (e.g. mcp-remote's machine-wide ~/.mcp-auth) and
	// produces the misleading "reauthorization is not required".
	if (config.type !== "http" && config.type !== "sse") {
		const remoteUrl = config.args?.find(arg => /^https?:\/\//.test(arg));
		const httpHint = `{ "type": "http", "url": ${JSON.stringify(remoteUrl ?? "<remote url>")} }`;
		const usesMcpRemote = [config.command, ...(config.args ?? [])].some(part => part?.includes("mcp-remote"));
		throw new Error(
			usesMcpRemote
				? `this server proxies OAuth through mcp-remote, which caches tokens machine-wide in ~/.mcp-auth (shared across every OMP profile). Clear ~/.mcp-auth to force a fresh login, or replace the proxy with ${httpHint} so OMP manages OAuth per profile.`
				: `stdio servers manage their own credentials, so OMP has no OAuth to reauthorize. If the service supports OAuth over HTTP, configure it as ${httpHint} instead.`,
		);
	}
	// First test if server actually needs auth by connecting without OAuth
	let connectionSucceeded = false;
	let connectionError: Error | undefined;
	try {
		await testMcpConnection(ctx, stripOAuthAuth(config), { oauth: false });
		connectionSucceeded = true;
	} catch (error) {
		connectionError = error as Error;
	}

	// Server connected fine without auth — reauth is not needed
	if (connectionSucceeded) {
		throw new Error("Server connection succeeded without OAuth; reauthorization is not required.");
	}

	// Analyze the connection error to extract OAuth endpoints
	const authResult = analyzeAuthError(connectionError!, "url" in config ? config.url : undefined);
	let oauth = authResult.authType === "oauth" ? (authResult.oauth ?? null) : null;

	if (!oauth && (config.type === "http" || config.type === "sse") && config.url) {
		oauth = await discoverOAuthEndpoints(config.url, authResult.authServerUrl, authResult.resourceMetadataUrl, {
			protectedScopes: authResult.scopes,
		});
	}
	if (oauth && !oauth.scopes && authResult.resourceMetadataUrl) {
		// JSON-error-body path skips `discoverOAuthEndpoints`; fetch the
		// advertised protected-resource metadata for the required scopes.
		const scopes = await fetchResourceMetadataScopes(authResult.resourceMetadataUrl);
		if (scopes) oauth = { ...oauth, scopes };
	}

	if (!oauth) {
		throw new Error("Could not discover OAuth endpoints from server response.");
	}

	return oauth;
}
