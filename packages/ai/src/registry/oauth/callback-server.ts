/** Abstract base class for OAuth flows with local callback servers. */
import { scopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";
import * as AIError from "../../error";
import { renderOAuthResultHtml } from "./success-page";
import type { OAuthController, OAuthCredentials } from "./types";

const DEFAULT_TIMEOUT = 300_000;
const DEFAULT_HOSTNAME = "localhost";
/** Default loopback path for OAuth callback redirect (/callback). */
export const DEFAULT_CALLBACK_PATH = "/callback";
/** Path served by OAuthCallbackFlow that 302-redirects to the pending authorization URL. */
const LAUNCH_PATH = "/launch";

export type CallbackResult = { code: string; state: string };

export interface OAuthCallbackFlowOptions {
	preferredPort: number;
	callbackPath?: string;
	callbackHostname?: string;
	/** Exact redirect URI advertised to the provider; disables port fallback. */
	redirectUri?: string;
	/** Whether flow may bind to random port if preferredPort is in use (default true). */
	allowPortFallback?: boolean;
	/** Skip the local callback server entirely; the user pastes the code or redirect URL back. */
	manualInputOnly?: boolean;
}

export abstract class OAuthCallbackFlow {
	ctrl: OAuthController;
	preferredPort: number;
	callbackPath: string;
	callbackHostname: string;
	redirectUri?: string;
	allowPortFallback: boolean;
	#manualInputOnly: boolean;
	#callbackResolve?: (result: CallbackResult) => void;
	#callbackReject?: (error: string) => void;
	/** Authorization URL the /launch route currently redirects to. */
	#pendingAuthUrl?: string;

	constructor(
		ctrl: OAuthController,
		preferredPortOrOptions: number | OAuthCallbackFlowOptions,
		callbackPath: string = DEFAULT_CALLBACK_PATH,
	) {
		this.ctrl = ctrl;
		if (typeof preferredPortOrOptions === "number") {
			this.preferredPort = preferredPortOrOptions;
			this.callbackPath = callbackPath;
			this.callbackHostname = DEFAULT_HOSTNAME;
			this.allowPortFallback = true;
			this.#manualInputOnly = false;
			return;
		}

		this.preferredPort = preferredPortOrOptions.preferredPort;
		this.callbackPath = preferredPortOrOptions.callbackPath ?? DEFAULT_CALLBACK_PATH;
		this.callbackHostname = preferredPortOrOptions.callbackHostname ?? DEFAULT_HOSTNAME;
		this.redirectUri = preferredPortOrOptions.redirectUri;
		this.allowPortFallback = preferredPortOrOptions.allowPortFallback ?? true;
		this.#manualInputOnly = preferredPortOrOptions.manualInputOnly ?? false;
	}

	/** Generate provider-specific authorization URL. */
	abstract generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }>;

	/** Exchange authorization code for OAuth tokens. */
	abstract exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials>;

	/** Generate CSRF state token. */
	generateState(): string {
		const bytes = new Uint8Array(16);
		crypto.getRandomValues(bytes);
		return Array.from(bytes)
			.map(value => value.toString(16).padStart(2, "0"))
			.join("");
	}

	#loginCancelledError(): AIError.LoginCancelledError {
		return new AIError.LoginCancelledError(`OAuth callback cancelled: ${this.ctrl.signal?.reason}`);
	}

	#throwIfCancelled(): void {
		if (this.ctrl.signal?.aborted) throw this.#loginCancelledError();
	}

	/** Execute the OAuth login flow. */
	async login(): Promise<OAuthCredentials> {
		const state = this.generateState();
		this.#throwIfCancelled();

		const { server, redirectUri, launchUrl } = this.#manualInputOnly
			? { server: undefined, redirectUri: this.#buildRedirectUri(), launchUrl: undefined }
			: await this.#startCallbackServer(state);

		try {
			this.#throwIfCancelled();
			const { url: authUrl, instructions } = await this.generateAuthUrl(state, redirectUri);
			this.#throwIfCancelled();

			this.#pendingAuthUrl = authUrl;

			this.ctrl.onAuth?.({ url: authUrl, launchUrl, instructions });
			this.ctrl.onProgress?.(
				this.#manualInputOnly
					? "Waiting for pasted authorization code..."
					: "Waiting for browser authentication...",
			);

			const { code } = await this.#waitForCallback(state);
			this.#throwIfCancelled();

			this.ctrl.onProgress?.("Exchanging authorization code for tokens...");

			return await this.exchangeToken(code, state, redirectUri);
		} finally {
			this.#pendingAuthUrl = undefined;
			server?.stop();
		}
	}

	#buildRedirectUri(): string {
		return this.redirectUri ?? `http://${this.callbackHostname}:${this.preferredPort}${this.callbackPath}`;
	}

	/** Start callback server on preferred port, falling back to random port if allowed. */
	async #startCallbackServer(
		expectedState: string,
	): Promise<{ server: Bun.Server<unknown>; redirectUri: string; launchUrl: string | undefined }> {
		try {
			const server = this.#createServer(this.preferredPort, expectedState);
			const actualPort = this.#resolveServerPort(server);
			const launchUrl = this.#launchUrlIfSafe(actualPort);
			if (this.redirectUri) {
				return { server, redirectUri: this.redirectUri, launchUrl };
			}
			const redirectUri = `http://${this.callbackHostname}:${actualPort}${this.callbackPath}`;
			return { server, redirectUri, launchUrl };
		} catch (cause) {
			if (this.redirectUri) {
				throw new AIError.ConfigurationError(
					`OAuth callback port ${this.preferredPort} is in use, but oauth.redirectUri (${this.redirectUri}) requires this exact port. Free port ${this.preferredPort} (e.g. stop the process bound to it) and retry, or change oauth.redirectUri to point at an available port.`,
					{ cause },
				);
			}
			if (!this.allowPortFallback) {
				throw new AIError.ConfigurationError(
					`OAuth callback port ${this.preferredPort} is in use. The OAuth provider validates redirect URIs against its registered callback, so falling back to a random port would be rejected. Free port ${this.preferredPort} (e.g. stop the process bound to it) and retry, or set oauth.callbackPort/oauth.redirectUri to a port the provider has registered.`,
					{ cause },
				);
			}
			const server = this.#createServer(0, expectedState);
			const actualPort = this.#resolveServerPort(server);
			const redirectUri = `http://${this.callbackHostname}:${actualPort}${this.callbackPath}`;
			const launchUrl = this.#launchUrlIfSafe(actualPort);
			this.ctrl.onProgress?.(`Preferred port ${this.preferredPort} unavailable, using port ${actualPort}`);
			return { server, redirectUri, launchUrl };
		}
	}

	/** Read numeric port from bound server. */
	#resolveServerPort(server: Bun.Server<unknown>): number {
		const port = server.port;
		if (typeof port !== "number") {
			throw new AIError.ConfigurationError(
				"OAuth callback server bound to a non-TCP endpoint; expected a numeric port. Check `oauth.callbackPort`/`oauth.redirectUri`.",
			);
		}
		return port;
	}

	/** Build viewport-safe /launch redirect URL. */
	#launchUrlIfSafe(port: number): string | undefined {
		if (this.callbackPath === LAUNCH_PATH) return undefined;
		if (this.redirectUri) {
			try {
				const parsed = new URL(this.redirectUri);
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
				if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]") {
					return undefined;
				}
				if (parsed.pathname === LAUNCH_PATH) return undefined;
			} catch {
				return undefined;
			}
		}
		return `http://${this.callbackHostname}:${port}${LAUNCH_PATH}`;
	}

	#createServer(port: number, expectedState: string): Bun.Server<unknown> {
		const hostname = this.callbackHostname === DEFAULT_HOSTNAME ? undefined : this.callbackHostname;
		return Bun.serve({
			...(hostname === undefined ? {} : { hostname }),
			port,
			reusePort: false,
			fetch: req => this.#handleCallback(req, expectedState),
		});
	}

	/** Handle OAuth callback HTTP request. */
	#handleCallback(req: Request, expectedState: string): Response {
		const url = new URL(req.url);

		if (url.pathname !== this.callbackPath) {
			if (url.pathname === LAUNCH_PATH) {
				const pending = this.#pendingAuthUrl;
				if (!pending) {
					return new Response("OAuth launch URL is no longer active", { status: 503 });
				}
				return Response.redirect(pending, 302);
			}
			return new Response("Not Found", { status: 404 });
		}

		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state") || "";
		const error = url.searchParams.get("error") || "";
		const errorDescription = url.searchParams.get("error_description") || error;

		type OkState = { ok: true; code: string; state: string };
		type ErrorState = { ok?: false; error?: string };
		let resultState: OkState | ErrorState;

		if (error) {
			resultState = { ok: false, error: `Authorization failed: ${errorDescription}` };
		} else if (!code) {
			resultState = { ok: false, error: "Missing authorization code" };
		} else if (expectedState && state !== expectedState) {
			resultState = { ok: false, error: "State mismatch - possible CSRF attack" };
		} else {
			resultState = { ok: true, code, state };
		}

		// Signal to waitForCallback - capture refs before they could be cleared
		const resolve = this.#callbackResolve;
		const reject = this.#callbackReject;
		queueMicrotask(() => {
			if (resultState.ok) {
				resolve?.({ code: resultState.code, state: resultState.state });
			} else {
				reject?.(resultState.error ?? "Unknown error");
			}
		});

		return new Response(renderOAuthResultHtml(resultState), {
			status: resultState.ok ? 200 : 500,
			headers: { "Content-Type": "text/html" },
		});
	}

	/** Wait for OAuth callback or manual code input. */
	#waitForCallback(expectedState: string): Promise<CallbackResult> {
		const waitTimeout = scopedTimeoutSignal(DEFAULT_TIMEOUT, this.ctrl.signal);
		const signal = waitTimeout.signal;
		if (signal.aborted) {
			waitTimeout.cancel();
			return Promise.reject(this.#loginCancelledError());
		}
		const settled = <T>(promise: Promise<T>): Promise<T> => promise.finally(() => waitTimeout.cancel());

		const callback = Promise.withResolvers<CallbackResult>();
		this.#callbackResolve = callback.resolve;
		this.#callbackReject = callback.reject;

		signal.addEventListener("abort", () => {
			this.#callbackResolve = undefined;
			this.#callbackReject = undefined;
			callback.reject(new AIError.LoginCancelledError(`OAuth callback cancelled: ${signal.reason}`));
		});
		const callbackPromise = callback.promise;

		if (this.ctrl.onManualCodeInput) {
			const requestManualInput = this.ctrl.onManualCodeInput;
			const manualPromise = (async (): Promise<CallbackResult> => {
				while (true) {
					const result = await Promise.race([
						callbackPromise,
						requestManualInput()
							.then((input): CallbackResult | null => {
								const parsed = parseCallbackInput(input);
								if (!parsed.code) return null;
								if (expectedState && parsed.state !== expectedState) return null;
								return { code: parsed.code, state: parsed.state ?? "" };
							})
							.catch((): CallbackResult | null => null),
					]);
					if (result) return result;
				}
			})();

			return settled(Promise.race([callbackPromise, manualPromise]));
		}

		return settled(callbackPromise);
	}
}

/** Parse redirect URL or query string to extract authorization code and state. */
export function parseCallbackInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value.replace(/^[?#]/, ""));
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	const [code, state] = value.split("#", 2);
	return { code, state };
}
