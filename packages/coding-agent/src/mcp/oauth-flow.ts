import { OAuthCallbackFlow } from "@veyyon/ai/oauth/callback-server";
import type { OAuthController, OAuthCredentials } from "@veyyon/ai/oauth/types";
import type { FetchImpl } from "@veyyon/ai/types";
import { truncate } from "@veyyon/utils";
import type { MCPOAuthConfig } from "./oauth-flow-helpers";
import {
	filterResourceIndicator,
	hasOAuthScope,
	readRegistrationFailureDetail,
	resolveCallbackOptions,
	resolveResourceUri,
	staticClientIdFromConfig,
	truncateDetail,
} from "./oauth-flow-helpers";

export type { MCPStoredOAuthCredential } from "./oauth-flow-helpers";
export { isManagedMCPOAuthCredentialId, mcpOAuthCredentialId, mcpOAuthCredentialProfile } from "./oauth-flow-helpers";

export class MCPOAuthFlow extends OAuthCallbackFlow {
	#resolvedClientId?: string;
	#registeredClientSecret?: string;
	#codeVerifier?: string;
	#fetch: FetchImpl;
	#resource?: string;
	#registrationFailure?: {
		endpoint: string;
		status: number;
		detail?: string;
	};

	constructor(
		private config: MCPOAuthConfig,
		ctrl: OAuthController,
	) {
		super(ctrl, resolveCallbackOptions(config));
		this.#resolvedClientId = this.#resolveClientId(config);
		this.#fetch = config.fetch ?? ctrl.fetch ?? fetch;
		this.#resource = this.#filterResourceIndicator(
			resolveResourceUri(config.resource ?? this.#resourceFromAuthorizationUrl(config.authorizationUrl)),
		);
	}

	get resolvedClientId(): string | undefined {
		return this.#resolvedClientId;
	}

	get registeredClientSecret(): string | undefined {
		return this.#registeredClientSecret;
	}
	get resource(): string | undefined {
		return this.#resource;
	}
	get authorizationUrl(): string {
		return this.config.authorizationUrl;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		if (!this.#resolvedClientId) {
			await this.#tryRegisterClient(redirectUri);
		}

		const authUrl = new URL(this.config.authorizationUrl);
		const params = authUrl.searchParams;

		if (!params.get("response_type")) {
			params.set("response_type", "code");
		}
		const existingClientId = params.get("client_id")?.trim();
		if (this.#resolvedClientId && !existingClientId) {
			params.set("client_id", this.#resolvedClientId);
		}
		if (this.config.scopes && !params.get("scope")) {
			params.set("scope", this.config.scopes);
		}
		const prompt = this.config.prompt ?? (hasOAuthScope(params.get("scope"), "offline_access") ? "consent" : "");
		if (prompt && !params.get("prompt")) {
			params.set("prompt", prompt);
		}
		const existingResource = params.get("resource")?.trim();
		if (existingResource) {
			const filtered = filterResourceIndicator(resolveResourceUri(existingResource), this.config.authorizationUrl);
			if (filtered) {
				this.#resource = filtered;
			} else {
				params.delete("resource");
				this.#resource = undefined;
			}
		} else if (this.#resource) {
			params.set("resource", this.#resource);
		}
		params.set("redirect_uri", redirectUri);
		params.set("state", state);

		const codeVerifier = this.#generateCodeVerifier();
		const codeChallenge = await this.#generateCodeChallenge(codeVerifier);
		params.set("code_challenge", codeChallenge);
		params.set("code_challenge_method", "S256");

		this.#codeVerifier = codeVerifier;

		if (!params.get("client_id")) {
			await this.#assertClientIdNotRequired(authUrl.toString());
		}

		return { url: authUrl.toString() };
	}

	async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
		const params = new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
		});
		if (this.#resolvedClientId) {
			params.set("client_id", this.#resolvedClientId);
		}

		if (this.#codeVerifier) {
			params.set("code_verifier", this.#codeVerifier);
		}
		this.#codeVerifier = undefined;

		if (this.#resource) {
			params.set("resource", this.#resource);
		}
		const clientSecret = this.config.clientSecret ?? this.#registeredClientSecret;
		if (clientSecret) {
			params.set("client_secret", clientSecret);
		}

		const response = await this.#fetch(this.config.tokenUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: params.toString(),
			signal: this.ctrl.signal,
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`The authorization server at ${this.config.tokenUrl} rejected the token exchange with HTTP ${response.status}: ${truncate(errorText.trim(), 512)}. Fix: run \`/mcp reauth <name>\` to start the authorization again (\`/mcp list\` gives the name). If the response says \`invalid_client\`, this provider needs a pre-registered client: set \`oauth.clientId\` (and \`oauth.clientSecret\` if it requires one) on this server's entry in your MCP config.`,
			);
		}

		const data = (await response.json()) as {
			access_token: string;
			refresh_token?: string;
			expires_in?: number;
			token_type?: string;
		};

		const expiresIn = data.expires_in ?? 3600; // Default to 1 hour
		const expires = Date.now() + expiresIn * 1000;

		return {
			access: data.access_token,
			refresh: data.refresh_token ?? "",
			expires,
		};
	}

	#generateCodeVerifier(): string {
		const bytes = new Uint8Array(32);
		crypto.getRandomValues(bytes);
		return this.#base64UrlEncode(bytes);
	}

	async #generateCodeChallenge(verifier: string): Promise<string> {
		const encoder = new TextEncoder();
		const data = encoder.encode(verifier);
		const hash = await crypto.subtle.digest("SHA-256", data);
		return this.#base64UrlEncode(new Uint8Array(hash));
	}

	#base64UrlEncode(bytes: Uint8Array): string {
		const base64 = btoa(String.fromCharCode(...bytes));
		return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
	}

	#resolveClientId(config: MCPOAuthConfig): string | undefined {
		return staticClientIdFromConfig(config);
	}
	#resourceFromAuthorizationUrl(authorizationUrl: string): string | undefined {
		try {
			return new URL(authorizationUrl).searchParams.get("resource") ?? undefined;
		} catch {
			return undefined;
		}
	}

	#filterResourceIndicator(resource: string | undefined): string | undefined {
		return filterResourceIndicator(resource, this.config.authorizationUrl, {
			stripSameOriginResource: this.config.stripSameOriginResource,
		});
	}

	async #tryRegisterClient(redirectUri: string): Promise<void> {
		const registrationEndpoint = this.config.registrationUrl ?? (await this.#resolveRegistrationEndpoint());
		if (!registrationEndpoint) return;

		try {
			const registrationBody: Record<string, unknown> = {
				client_name: "veyyon",
				redirect_uris: [redirectUri],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
				application_type: "native",
			};
			const scope = this.config.scopes?.trim();
			if (scope) {
				registrationBody.scope = scope;
			}
			const response = await this.#fetch(registrationEndpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				signal: this.ctrl.signal,
				body: JSON.stringify(registrationBody),
			});

			if (!response.ok) {
				this.#registrationFailure = {
					endpoint: registrationEndpoint,
					status: response.status,
					detail: await readRegistrationFailureDetail(response),
				};
				return;
			}

			const data = (await response.json()) as {
				client_id?: string;
				client_secret?: string;
			};

			if (data.client_id && data.client_id.trim() !== "") {
				this.#resolvedClientId = data.client_id;
			}
			if (data.client_secret && data.client_secret.trim() !== "") {
				this.#registeredClientSecret = data.client_secret;
			}
		} catch (error) {
			this.#registrationFailure = {
				endpoint: registrationEndpoint,
				status: 0,
				detail: error instanceof Error ? truncateDetail(error.message) : undefined,
			};
		}
	}

	async #resolveRegistrationEndpoint(): Promise<string | null> {
		const authorizationUrl = new URL(this.config.authorizationUrl);

		const rootUrl = new URL("/.well-known/oauth-authorization-server", authorizationUrl.origin).toString();
		const endpoint = await this.#tryWellKnownForRegistration(rootUrl);
		if (endpoint) return endpoint;

		const normalizedPath = authorizationUrl.pathname.replace(/\/$/, "");
		const lastSlash = normalizedPath.lastIndexOf("/");
		if (lastSlash < 0) return null;

		const prefixPath = lastSlash === 0 ? normalizedPath : normalizedPath.slice(0, lastSlash);
		const prefixedUrl = new URL(
			".well-known/oauth-authorization-server",
			`${authorizationUrl.origin}${prefixPath}/`,
		).toString();
		const prefixedEndpoint = await this.#tryWellKnownForRegistration(prefixedUrl);
		if (prefixedEndpoint) return prefixedEndpoint;

		const pathfulUrl = new URL(
			`/.well-known/oauth-authorization-server${normalizedPath}`,
			authorizationUrl.origin,
		).toString();
		return await this.#tryWellKnownForRegistration(pathfulUrl);
	}

	async #tryWellKnownForRegistration(wellKnownUrl: string): Promise<string | null> {
		try {
			const response = await this.#fetch(wellKnownUrl, {
				method: "GET",
				headers: { Accept: "application/json" },
				signal: this.ctrl.signal,
			});
			if (!response.ok) return null;
			const metadata = (await response.json()) as { registration_endpoint?: string };
			if (metadata.registration_endpoint && metadata.registration_endpoint.trim() !== "") {
				return metadata.registration_endpoint;
			}
		} catch {}
		return null;
	}

	async #assertClientIdNotRequired(authorizationUrl: string): Promise<void> {
		try {
			const response = await this.#fetch(authorizationUrl, {
				method: "GET",
				redirect: "manual",
				headers: { Accept: "text/plain,text/html,application/json" },
				signal: this.ctrl.signal,
			});
			if (response.status < 400) return;
			const body = await response.text();
			if (/client[_-]?id/i.test(body) && /(required|missing|invalid)/i.test(body)) {
				throw this.#missingClientIdError();
			}
		} catch (error) {
			if (error instanceof Error && /client[_-]?id/i.test(error.message)) {
				throw error;
			}
		}
	}

	#missingClientIdError(): Error {
		const failure = this.#registrationFailure;
		const manualHint =
			"Configure `oauth.clientId` (and `oauth.clientSecret` if the flow needs one) on the MCP server entry in mcp.json.";
		if (!failure) {
			return new Error(
				`OAuth provider requires client_id, and no dynamic-client-registration endpoint was advertised. ${manualHint}`,
			);
		}
		const outcome =
			failure.status > 0
				? `HTTP ${failure.status}${failure.detail ? ` — ${failure.detail}` : ""}`
				: failure.detail
					? `network error — ${failure.detail}`
					: "network error";
		return new Error(
			`OAuth provider requires client_id, and dynamic client registration was rejected ` +
				`(POST ${failure.endpoint} → ${outcome}). The server likely restricts registration to pre-approved clients. ${manualHint}`,
		);
	}
}

export interface RefreshMCPOAuthTokenOptions {
	fetch?: FetchImpl;
	signal?: AbortSignal;
	authorizationUrl?: string;
	stripSameOriginResource?: boolean;
}

export async function refreshMCPOAuthToken(
	tokenUrl: string,
	refreshToken: string,
	clientId?: string,
	clientSecret?: string,
	resourceOrOpts?: string | RefreshMCPOAuthTokenOptions,
	opts?: RefreshMCPOAuthTokenOptions,
): Promise<OAuthCredentials> {
	const optsFromTrailing = typeof resourceOrOpts === "string" ? opts : resourceOrOpts;
	const fetchImpl: FetchImpl = optsFromTrailing?.fetch ?? fetch;
	const resource = typeof resourceOrOpts === "string" ? resourceOrOpts : undefined;
	const filterAnchor = optsFromTrailing?.authorizationUrl ?? tokenUrl;
	const params = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: refreshToken,
	});
	if (clientId) params.set("client_id", clientId);
	const resolvedResource = filterResourceIndicator(resolveResourceUri(resource), filterAnchor, {
		stripSameOriginResource: optsFromTrailing?.stripSameOriginResource,
	});
	if (resolvedResource) params.set("resource", resolvedResource);
	if (clientSecret) params.set("client_secret", clientSecret);

	const response = await fetchImpl(tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString(),
		signal: optsFromTrailing?.signal,
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(
			`The authorization server at ${tokenUrl} refused to refresh this MCP server's token, answering HTTP ${response.status}: ${truncate(text.trim(), 512)}. Fix: the stored grant is no longer usable, so refreshing again will not help. Run \`/mcp reauth <name>\` to authorize from scratch; \`/mcp list\` gives the server's name.`,
		);
	}

	const data = (await response.json()) as {
		access_token: string;
		refresh_token?: string;
		expires_in?: number;
	};
	const expiresIn = data.expires_in ?? 3600;
	return {
		access: data.access_token,
		refresh: data.refresh_token ?? refreshToken,
		expires: Date.now() + expiresIn * 1000,
	};
}
