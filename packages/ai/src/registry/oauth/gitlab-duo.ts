import { GITLAB_SAAS_URL } from "@veyyon/catalog/provider-endpoints";
import * as AIError from "../../error";
import { clearGitLabDuoDirectAccessCache } from "../../providers/gitlab-duo";
import type { FetchImpl } from "../../types";
import { OAuthCallbackFlow, type OAuthCallbackFlowOptions } from "./callback-server";
import type { PKCEPair } from "./gitlab-duo-helpers";
import { mapTokenResponse, OAUTH_SCOPES, resolveCallbackOptions, resolveClientId } from "./gitlab-duo-helpers";
import { generatePKCE } from "./pkce";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./types";

class GitLabDuoOAuthFlow extends OAuthCallbackFlow {
	#pkce: PKCEPair;
	#clientId: string;
	#fetch: FetchImpl;

	constructor(ctrl: OAuthLoginCallbacks, pkce: PKCEPair, clientId: string, options: OAuthCallbackFlowOptions) {
		super(ctrl, options);
		this.#pkce = pkce;
		this.#clientId = clientId;
		this.#fetch = ctrl.fetch ?? fetch;
	}

	override async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const authParams = new URLSearchParams({
			client_id: this.#clientId,
			redirect_uri: redirectUri,
			response_type: "code",
			scope: OAUTH_SCOPES.join(" "),
			code_challenge: this.#pkce.challenge,
			code_challenge_method: "S256",
			state,
		});

		return {
			url: `${GITLAB_SAAS_URL}/oauth/authorize?${authParams.toString()}`,
			instructions:
				'Complete GitLab login in browser. If GitLab responds with "The redirect URI included is not valid", ' +
				"register your own GitLab OAuth application and set GITLAB_CLIENT_ID + GITLAB_REDIRECT_URI, or use a " +
				"Personal Access Token via GITLAB_TOKEN.",
		};
	}

	override async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
		const response = await this.#fetch(`${GITLAB_SAAS_URL}/oauth/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: this.#clientId,
				grant_type: "authorization_code",
				code,
				code_verifier: this.#pkce.verifier,
				redirect_uri: redirectUri,
			}).toString(),
		});

		if (!response.ok) {
			throw new AIError.OAuthError(
				`GitLab OAuth token exchange failed: ${response.status} ${await AIError.readProviderErrorDetail(response)}`,
				{
					kind: "token-exchange",
					provider: "gitlab-duo",
					status: response.status,
				},
			);
		}

		clearGitLabDuoDirectAccessCache();
		return mapTokenResponse(
			(await response.json()) as {
				access_token?: string;
				refresh_token?: string;
				expires_in?: number;
				created_at?: number;
			},
		);
	}
}

export async function loginGitLabDuo(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const pkce = await generatePKCE();
	const clientId = resolveClientId();
	const options = resolveCallbackOptions();
	const flow = new GitLabDuoOAuthFlow(callbacks, pkce, clientId, options);
	return flow.login();
}

export async function refreshGitLabDuoToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const response = await fetch(`${GITLAB_SAAS_URL}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: resolveClientId(),
			grant_type: "refresh_token",
			refresh_token: credentials.refresh,
		}).toString(),
	});

	if (!response.ok) {
		const detail = await AIError.readProviderErrorDetail(response);
		throw new AIError.OAuthError(`GitLab OAuth refresh failed: ${response.status} ${detail}`, {
			kind: "token-refresh",
			provider: "gitlab-duo",
			status: response.status,
		});
	}

	clearGitLabDuoDirectAccessCache();
	return mapTokenResponse(
		(await response.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
			created_at?: number;
		},
	);
}
