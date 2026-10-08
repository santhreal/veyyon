/**
 * MCP OAuth login for `/mcp add` and `/mcp reauth`: the browser authorization
 * flow, its cancellation, the stored credential, and the config entry that
 * points at it.
 */
import type { AuthStorage } from "@veyyon/ai/auth-storage";
import type { OAuthCredentials } from "@veyyon/ai/oauth/types";
import { type Component, Spacer, Text } from "@veyyon/tui";
import { errorMessage } from "@veyyon/utils";
import { raceWithTimeout } from "@veyyon/utils/scoped-timeout";
import { replaceTabs } from "@veyyon/utils/tab-width";
import {
	type AuthDetectionResult,
	discoverOAuthEndpoints,
	fetchResourceMetadataScopes,
	type OAuthEndpoints,
} from "../../../mcp";
import { MCPOAuthFlow, type MCPStoredOAuthCredential, mcpOAuthCredentialId } from "../../../mcp/oauth-flow";
import type { MCPServerConfig, MCPStdioServerConfig } from "../../../mcp/types";
import { theme } from "../../../theme/theme";
import { copyToClipboard } from "../../../utils/clipboard";
import { openPath } from "../../../utils/open";
import { TranscriptBlock } from "../components/transcript/transcript-container";
import { urlHyperlinkAlways } from "../draw/hyperlink";
import type { OAuthManualInputClaim, OAuthManualInputManager } from "../oauth-manual-input";
import type { InteractiveModeContext } from "../types";

/** The slice of the interactive context an MCP OAuth login uses. */
export type McpOAuthLoginContext = Pick<
	InteractiveModeContext,
	"editor" | "oauthManualInput" | "present" | "session" | "ui"
>;

/**
 * Outcome of {@link loginWithMcpOAuth}.
 *
 * `credentialId` is deterministic per server URL when the URL was supplied, so
 * every profile resolves its own credential row under the same id. Refresh
 * material (token URL, client id/secret) is embedded in the stored credential;
 * the returned `clientId` may be folded into `mcp.json` for pre-auth reuse.
 * DCR-issued client secrets stay embedded in the stored credential and are
 * not returned here, so they cannot leak into config files.
 */
export interface McpOAuthLoginResult {
	credentialId: string;
	clientId?: string;
	resource?: string;
}

export interface McpOAuthLoginOptions {
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
	 * controller here; editor-focused callers rely on the editor's Esc hook,
	 * which the login installs for its duration.
	 */
	abortSignal?: AbortSignal;
}

/**
 * Thrown by {@link loginWithMcpOAuth} when the user (or a caller-supplied
 * {@link AbortSignal}) cancels the in-flight flow. Distinct from
 * network/timeout failures so callers can show a neutral "cancelled" status
 * instead of an error banner.
 */
export class MCPOAuthCancelledError extends Error {
	constructor(message = "OAuth flow cancelled") {
		super(message);
		this.name = "MCPOAuthCancelledError";
	}
}

const MCP_MANUAL_INPUT_PROVIDER_ID = "mcp";
const MCP_MANUAL_LOGIN_TIP = "Headless? Paste the redirect URL or code with /login <value>.";
/** Reason recorded on the OAuth flow's AbortController when the user hits Esc. */
const MCP_OAUTH_USER_CANCEL_REASON = "MCP OAuth flow cancelled by user";
const MCP_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

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
 * column 0. Continuation chunks carry ZERO leading bytes: a multi-row terminal
 * selection includes the newline plus any leading indent, and while address
 * bars strip newlines they preserve or percent-encode embedded spaces, so an
 * indent would corrupt the URL at every chunk boundary (silently, when the
 * damage lands inside a query value).
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
 * SSH/WSL/headless sessions where the Veyyon-hosted `/launch` loopback URL would
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
 * Run the browser OAuth flow against `authUrl`/`tokenUrl` and store the
 * resulting credential. Esc in the editor and `opts.abortSignal` cancel it
 * with {@link MCPOAuthCancelledError}; it fails after five minutes without an
 * authorization.
 */
export async function loginWithMcpOAuth(
	ctx: McpOAuthLoginContext,
	authUrl: string,
	tokenUrl: string,
	clientId: string,
	clientSecret: string,
	scopes: string,
	opts?: McpOAuthLoginOptions,
): Promise<McpOAuthLoginResult> {
	const parsedAuthUrl = parseOAuthUrls(authUrl, tokenUrl);
	const resolvedClientId = clientId.trim() || parsedAuthUrl.searchParams.get("client_id") || undefined;
	const resolvedClientSecret = clientSecret.trim() || undefined;
	const manualInput = new McpManualCodeInput(ctx.oauthManualInput);
	const cancellation = new McpOAuthCancellation(ctx.editor, opts?.abortSignal);
	try {
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
				onAuth: info => presentAuthorizationPrompt(ctx, info),
				onProgress: message => ctx.present([new Spacer(1), new Text(theme.fg("muted", message), 1, 0)]),
				onManualCodeInput: () => manualInput.claim(),
				signal: cancellation.signal,
			},
		);
		const credentials = await cancellation.race(() => flow.login());
		ctx.present([new Spacer(1), new Text(theme.fg("success", "ok Authorization completed in browser."), 1, 0)]);
		return await storeOAuthCredential(ctx.session.modelRegistry.authStorage, flow, credentials, {
			tokenUrl,
			serverUrl: opts?.serverUrl,
			clientId: resolvedClientId,
			clientSecret: resolvedClientSecret,
		});
	} catch (error) {
		// A user-initiated cancel (Esc or the external signal) is a neutral status, not a failure. The flag
		// decides it rather than the abort reason: the timeout aborts the same signal and has to surface as a
		// timeout error.
		throw cancellation.userCancelled ? new MCPOAuthCancelledError() : oauthFailure(error);
	} finally {
		cancellation.dispose();
		manualInput.clear();
	}
}

/** The parsed authorization URL; throws naming both URLs when either is not a URL. */
function parseOAuthUrls(authUrl: string, tokenUrl: string): URL {
	try {
		const parsedAuthUrl = new URL(authUrl);
		new URL(tokenUrl);
		return parsedAuthUrl;
	} catch {
		throw new Error(`Invalid OAuth URLs. Please check:\n  Authorization URL: ${authUrl}\n  Token URL: ${tokenUrl}`);
	}
}

function manualInputBusy(pendingProviderId: string | undefined): Error {
	return new Error(
		`OAuth login already in progress for ${pendingProviderId ?? "another provider"}. Complete or cancel it before starting MCP OAuth.`,
	);
}

/**
 * The `/login <value>` input slot of one login. The slot is shared by every
 * OAuth login in the session, so a login that finds it held by another fails
 * at once, and the slot is claimed only when the flow asks for a pasted code.
 */
class McpManualCodeInput {
	readonly #input: OAuthManualInputManager;
	#claim: OAuthManualInputClaim | undefined;

	constructor(input: OAuthManualInputManager) {
		if (input.hasPending()) throw manualInputBusy(input.pendingProviderId);
		this.#input = input;
	}

	claim(): Promise<string> {
		if (this.#claim) return this.#claim.promise;
		const claim = this.#input.tryClaimInput(MCP_MANUAL_INPUT_PROVIDER_ID);
		if (!claim) throw manualInputBusy(this.#input.pendingProviderId);
		this.#claim = claim;
		return claim.promise;
	}

	clear(): void {
		this.#claim?.clear("Manual MCP OAuth input cleared");
	}
}

/**
 * The ways one login ends early: Esc in the editor or the caller's signal
 * (both a user cancel), or the five-minute deadline. Installs the Esc hook on
 * construction; {@link dispose} restores the editor's previous hook.
 */
class McpOAuthCancellation {
	readonly #controller = new AbortController();
	readonly #editor: McpOAuthLoginContext["editor"];
	readonly #originalOnEscape: McpOAuthLoginContext["editor"]["onEscape"];
	readonly #external: AbortSignal | undefined;
	#userCancelled = false;

	constructor(editor: McpOAuthLoginContext["editor"], external: AbortSignal | undefined) {
		this.#editor = editor;
		this.#originalOnEscape = editor.onEscape;
		this.#external = external;
		editor.onEscape = () => this.#cancel(MCP_OAUTH_USER_CANCEL_REASON);
		if (external?.aborted) this.#onExternalAbort();
		else external?.addEventListener("abort", this.#onExternalAbort, { once: true });
	}

	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	get userCancelled(): boolean {
		return this.#userCancelled;
	}

	/**
	 * Settle `login` within the deadline. The login itself races the signal
	 * because Esc or the external signal may fire before `MCPOAuthFlow`
	 * reaches the callback wait, where the callback server observes it.
	 */
	race<T>(login: () => Promise<T>): Promise<T> {
		if (this.signal.aborted) throw this.#abortError();
		return raceWithTimeout(
			raceAbortSignal(login(), this.signal, () => this.#abortError()),
			MCP_OAUTH_TIMEOUT_MS,
			() => new Error("OAuth flow timed out after 5 minutes"),
			{ onTimeout: async () => this.#controller.abort("MCP OAuth flow timed out") },
		);
	}

	dispose(): void {
		this.#editor.onEscape = this.#originalOnEscape;
		this.#external?.removeEventListener("abort", this.#onExternalAbort);
	}

	#cancel(reason: string): void {
		this.#userCancelled = true;
		if (!this.#controller.signal.aborted) this.#controller.abort(reason);
	}

	readonly #onExternalAbort = (): void => {
		const reason = this.#external?.reason;
		this.#cancel(typeof reason === "string" ? reason : MCP_OAUTH_USER_CANCEL_REASON);
	};

	#abortError(): Error {
		const reason = String(this.signal.reason ?? "MCP OAuth flow aborted");
		return this.#userCancelled ? new MCPOAuthCancelledError() : new Error(reason);
	}
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

/** Show the authorization block in the transcript, then open `info.url` in the browser and copy it. */
function presentAuthorizationPrompt(ctx: McpOAuthLoginContext, info: { url: string; launchUrl?: string }): void {
	const block = new TranscriptBlock();
	ctx.present(block);
	block.addChild(new Text(theme.fg("accent", "━━━ OAuth Authorization Required ━━━"), 1, 0));
	block.addChild(new Spacer(1));
	block.addChild(new Text(theme.fg("muted", "Preparing browser authorization..."), 1, 0));
	block.addChild(new Spacer(1));
	block.addChild(
		new Text(theme.fg("muted", "Waiting for authorization... (Press Esc to cancel, 5 minute timeout)"), 1, 0),
	);
	block.addChild(new Text(theme.fg("muted", MCP_MANUAL_LOGIN_TIP), 1, 0));
	block.addChild(new Spacer(1));
	block.addChild(new Text(theme.fg("accent", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"), 1, 0));
	// `openPath` logs spawn failures and never throws, so the copy-URL fallback
	// always renders beneath the "attempting to open browser" line.
	openPath(info.url);
	// Stage the FULL authorization URL on the clipboard via OSC 52. The full
	// URL works from any machine (unlike `launchUrl`, which only resolves
	// against the Veyyon host), and the terminal writes OSC 52 to the user's
	// LOCAL clipboard even when Veyyon runs on a remote SSH box. The visible
	// copy-URL rows below cover terminals that ignore it.
	void copyToClipboard(info.url).catch(() => {});
	block.addChild(new Spacer(1));
	block.addChild(new Text(theme.fg("success", "→ Attempting to open browser..."), 1, 0));
	block.addChild(new Spacer(1));
	block.addChild(new Text(theme.fg("muted", "Alternative if browser did not open:"), 1, 0));
	block.addChild(new MCPAuthorizationLinkPrompt(info.url, info.launchUrl));
	ctx.ui.requestRender();
}

/**
 * Store `credentials` with the refresh material the flow resolved, so token
 * refresh works for configs that carry no auth block at all.
 */
async function storeOAuthCredential(
	authStorage: AuthStorage,
	flow: MCPOAuthFlow,
	credentials: OAuthCredentials,
	request: { tokenUrl: string; serverUrl?: string; clientId?: string; clientSecret?: string },
): Promise<McpOAuthLoginResult> {
	// Deterministic per-URL id: every profile resolves its own credential row
	// under the same key, so shared project configs stay profile-isolated.
	// Random fallback only for flows that never knew the server URL.
	const credentialId = request.serverUrl
		? mcpOAuthCredentialId(request.serverUrl)
		: `mcp_oauth_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
	const oauthCredential: MCPStoredOAuthCredential = {
		type: "oauth",
		...credentials,
		tokenUrl: request.tokenUrl,
		clientId: flow.resolvedClientId ?? request.clientId,
		clientSecret: flow.registeredClientSecret ?? request.clientSecret,
		resource: flow.resource,
		authorizationUrl: flow.authorizationUrl,
	};
	await authStorage.set(credentialId, oauthCredential);
	return { credentialId, clientId: flow.resolvedClientId, resource: flow.resource };
}

/** The error an OAuth login reports for `error`, with the likely cause when its text identifies one. */
function oauthFailure(error: unknown): Error {
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

/** The redirect settings a server's `oauth` block pins for its login. */
export function oauthRedirectOptions(oauth: MCPServerConfig["oauth"]): McpOAuthLoginOptions {
	return {
		callbackPort: oauth?.callbackPort,
		callbackPath: oauth?.callbackPath,
		redirectUri: oauth?.redirectUri,
		prompt: oauth?.prompt,
	};
}

/**
 * The OAuth endpoints an authentication failure from `url` leads to: the
 * endpoints the failure states, else the ones the server's well-known
 * documents advertise, completed with the scopes the protected-resource
 * metadata requires when neither states any. Null when no endpoints are found.
 * A failed well-known discovery rejects unless `ignoreDiscoveryFailure` is set,
 * which reads it as no endpoints.
 */
export async function oauthEndpointsForAuthFailure(
	authResult: AuthDetectionResult,
	url: string | undefined,
	options: { ignoreDiscoveryFailure: boolean },
): Promise<OAuthEndpoints | null> {
	let oauth = authResult.authType === "oauth" ? (authResult.oauth ?? null) : null;
	if (!oauth && url) {
		const discovery = discoverOAuthEndpoints(url, authResult.authServerUrl, authResult.resourceMetadataUrl, {
			protectedScopes: authResult.scopes,
		});
		oauth = options.ignoreDiscoveryFailure ? await discovery.catch(() => null) : await discovery;
	}
	if (oauth && !oauth.scopes && authResult.resourceMetadataUrl) {
		// The JSON-error-body path skips `discoverOAuthEndpoints`; fetch the
		// advertised protected-resource metadata for the required scopes.
		const scopes = await fetchResourceMetadataScopes(authResult.resourceMetadataUrl);
		if (scopes) oauth = { ...oauth, scopes };
	}
	return oauth;
}

/**
 * Fold a completed OAuth login back into a server config. The auth block
 * records the credential pointer plus refresh material, the oauth block echoes
 * the client id for pre-auth reuse, and only a user-supplied client secret is
 * ever written: DCR-issued secrets stay embedded in the stored credential so
 * they cannot leak into (possibly shared or committed) config files.
 */
export function persistOAuthResult(
	config: MCPServerConfig,
	result: McpOAuthLoginResult,
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
 * The client a reauthorization logs in as. A user-supplied client secret may
 * live in either block (the wizard writes it to `auth.clientSecret`). A
 * DCR-issued secret is embedded in the stored credential, never echoed back
 * into config files, and reused only for the client id it was issued to.
 */
export function reauthClient(
	config: MCPServerConfig,
	oauth: OAuthEndpoints,
	stored: MCPStoredOAuthCredential | undefined,
): { clientId: string; clientSecret: string; userClientSecret: string | undefined } {
	const clientId = oauth.clientId ?? config.oauth?.clientId ?? config.auth?.clientId ?? stored?.clientId ?? "";
	const storedClientSecret = stored?.clientId === clientId ? stored.clientSecret : undefined;
	const userClientSecret = config.oauth?.clientSecret ?? config.auth?.clientSecret;
	return { clientId, clientSecret: userClientSecret ?? storedClientSecret ?? "", userClientSecret };
}

/** Why a stdio server has no OAuth `/mcp reauth` can redo, with the http config to use instead. */
export function stdioOAuthRefusal(config: MCPStdioServerConfig): Error {
	const remoteUrl = config.args?.find(arg => /^https?:\/\//.test(arg));
	const httpHint = `{ "type": "http", "url": ${JSON.stringify(remoteUrl ?? "<remote url>")} }`;
	const usesMcpRemote = [config.command, ...(config.args ?? [])].some(part => part?.includes("mcp-remote"));
	return new Error(
		usesMcpRemote
			? `this server proxies OAuth through mcp-remote, which caches tokens machine-wide in ~/.mcp-auth (shared across every Veyyon profile). Clear ~/.mcp-auth to force a fresh login, or replace the proxy with ${httpHint} so Veyyon manages OAuth per profile.`
			: `stdio servers manage their own credentials, so Veyyon has no OAuth to reauthorize. If the service supports OAuth over HTTP, configure it as ${httpHint} instead.`,
	);
}
