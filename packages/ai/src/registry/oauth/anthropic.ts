import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import {
	AUTHORIZE_URL,
	CALLBACK_PORT,
	CLIENT_ID,
	formatErrorDetails,
	parseOAuthTokenResponse,
	postJson,
	resolveAccountIdentity,
	SCOPES,
	TOKEN_URL,
} from "./anthropic-helpers";
import { DEFAULT_CALLBACK_PATH, OAuthCallbackFlow } from "./callback-server";
import { credentialExpiryFromExpiresIn } from "./expiry";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";

export class AnthropicOAuthFlow extends OAuthCallbackFlow {
	#verifier: string = "";
	#challenge: string = "";
	#fetch: FetchImpl;

	constructor(ctrl: OAuthController) {
		super(ctrl, CALLBACK_PORT, DEFAULT_CALLBACK_PATH);
		this.#fetch = ctrl.fetch ?? fetch;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const pkce = await generatePKCE();
		this.#verifier = pkce.verifier;
		this.#challenge = pkce.challenge;

		const authParams = new URLSearchParams({
			code: "true",
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: redirectUri,
			scope: SCOPES,
			code_challenge: this.#challenge,
			code_challenge_method: "S256",
			state,
		});
		const url = `${AUTHORIZE_URL}?${authParams.toString()}`;

		return {
			url,
			instructions:
				"Complete login in your browser. If the browser cannot reach this machine, paste the final redirect URL or authorization code when prompted.",
		};
	}

	async exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials> {
		let exchangeCode = code;
		let exchangeState = state;
		const codeFragmentIndex = code.indexOf("#");
		if (codeFragmentIndex >= 0) {
			exchangeCode = code.slice(0, codeFragmentIndex);
			const codeFragmentState = code.slice(codeFragmentIndex + 1);
			if (codeFragmentState.length > 0) {
				exchangeState = codeFragmentState;
			}
		}

		let responseBody: string;
		try {
			responseBody = await postJson(
				TOKEN_URL,
				{
					grant_type: "authorization_code",
					client_id: CLIENT_ID,
					code: exchangeCode,
					state: exchangeState,
					redirect_uri: redirectUri,
					code_verifier: this.#verifier,
				},
				this.#fetch,
			);
		} catch (error) {
			throw new AIError.OAuthError(
				`Token exchange request failed. url=${TOKEN_URL}; redirect_uri=${redirectUri}; response_type=authorization_code; details=${formatErrorDetails(error)}`,
				{ kind: "token-exchange", provider: "anthropic", cause: error },
			);
		}

		const tokenData = parseOAuthTokenResponse(responseBody, "token exchange");
		const { accountId, email, orgId, orgName } = await resolveAccountIdentity(tokenData, this.#fetch, {
			includeOrg: true,
		});

		return {
			refresh: tokenData.refresh_token,
			access: tokenData.access_token,
			expires: credentialExpiryFromExpiresIn(tokenData.expires_in, { provider: "anthropic" }),
			accountId,
			email,
			orgId,
			orgName,
		};
	}
}

export async function loginAnthropic(ctrl: OAuthController): Promise<OAuthCredentials> {
	const flow = new AnthropicOAuthFlow(ctrl);
	return flow.login();
}

export async function refreshAnthropicToken(
	refreshToken: string,
	fetchOverride?: FetchImpl,
): Promise<OAuthCredentials> {
	const fetchImpl = fetchOverride ?? fetch;
	let responseBody: string;
	try {
		responseBody = await postJson(
			TOKEN_URL,
			{
				grant_type: "refresh_token",
				client_id: CLIENT_ID,
				refresh_token: refreshToken,
			},
			fetchImpl,
			{
				"anthropic-beta": "oauth-2025-04-20",
				"User-Agent": "anthropic-sdk-typescript/0.94.0 userOAuthProvider",
			},
		);
	} catch (error) {
		throw new AIError.OAuthError(
			`Anthropic token refresh request failed. url=${TOKEN_URL}; details=${formatErrorDetails(error)}`,
			{
				kind: "token-refresh",
				provider: "anthropic",
				cause: error,
			},
		);
	}

	const data = parseOAuthTokenResponse(responseBody, "token refresh");
	const { accountId, email } = await resolveAccountIdentity(data, fetchImpl);

	return {
		refresh: data.refresh_token || refreshToken,
		access: data.access_token,
		expires: credentialExpiryFromExpiresIn(data.expires_in, { provider: "anthropic" }),
		accountId,
		email,
	};
}
