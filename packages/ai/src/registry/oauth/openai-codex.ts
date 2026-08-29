import { OPENAI_HEADER_VALUES, readCodexTokenIdentity } from "@veyyon/catalog/wire/codex";

export { readCodexTokenIdentity };

import { withScopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { OAuthCallbackFlow, type OAuthCallbackFlowOptions } from "./callback-server";
import type { PKCE } from "./openai-codex-helpers";
import {
	CALLBACK_PATH,
	CALLBACK_PORT,
	CLIENT_ID,
	createOpenAICodexAuthorizationUrl,
	DEVICE_AUTH_URL,
	DEVICE_MAX_POLLS,
	DEVICE_POLL_INTERVAL_MS,
	DEVICE_POLL_SAFETY_MARGIN_MS,
	DEVICE_REDIRECT_URI,
	DEVICE_TOKEN_URL,
	DEVICE_USERCODE_URL,
	formatOpenAICodexTokenEndpointError,
	getTokenProfile,
	TOKEN_REQUEST_TIMEOUT_MS,
	TOKEN_URL,
} from "./openai-codex-helpers";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";

export { createOpenAICodexAuthorizationUrl, formatOpenAICodexTokenEndpointError };

class OpenAICodexOAuthFlow extends OAuthCallbackFlow {
	#pkce: PKCE;
	#originator: string;
	#fetch: FetchImpl;

	constructor(ctrl: OAuthController, pkce: PKCE, originator: string, fetchImpl: FetchImpl) {
		super(ctrl, {
			preferredPort: CALLBACK_PORT,
			callbackPath: CALLBACK_PATH,
			redirectUri: `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`,
		} satisfies OAuthCallbackFlowOptions);
		this.#pkce = pkce;
		this.#originator = originator;
		this.#fetch = fetchImpl;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const url = createOpenAICodexAuthorizationUrl({
			state,
			redirectUri,
			challenge: this.#pkce.challenge,
			originator: this.#originator,
		});
		return { url, instructions: "A browser window should open. Complete login to finish." };
	}

	async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
		return exchangeCodeForToken(code, this.#pkce.verifier, redirectUri, this.#fetch);
	}
}

async function exchangeCodeForToken(
	code: string,
	verifier: string,
	redirectUri: string,
	fetchImpl: FetchImpl = fetch,
): Promise<OAuthCredentials> {
	const tokenData = await withScopedTimeoutSignal(TOKEN_REQUEST_TIMEOUT_MS, async signal => {
		const tokenResponse = await fetchImpl(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				client_id: CLIENT_ID,
				code,
				code_verifier: verifier,
				redirect_uri: redirectUri,
			}),
			signal,
		});

		if (!tokenResponse.ok) {
			const bodyText = await tokenResponse.text();
			throw new AIError.OAuthError(
				`Token exchange failed: ${formatOpenAICodexTokenEndpointError(tokenResponse.status, bodyText)}`,
				{ kind: "token-exchange", status: tokenResponse.status },
			);
		}

		return (await tokenResponse.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
		};
	});

	if (!tokenData.access_token || !tokenData.refresh_token || typeof tokenData.expires_in !== "number") {
		throw new AIError.OAuthError("Token response missing required fields", { kind: "validation" });
	}

	const { accountId, email } = getTokenProfile(tokenData.access_token);
	if (!accountId) {
		throw new AIError.OAuthError("Failed to extract accountId from token", { kind: "validation" });
	}

	return {
		access: tokenData.access_token,
		refresh: tokenData.refresh_token,
		expires: Date.now() + tokenData.expires_in * 1000,
		accountId,
		email,
	};
}

export type OpenAICodexLoginOptions = OAuthController & {
	originator?: string;
};

export async function loginOpenAICodex(options: OpenAICodexLoginOptions): Promise<OAuthCredentials> {
	const pkce = await generatePKCE();
	const originator = options.originator?.trim() || OPENAI_HEADER_VALUES.ORIGINATOR_CODEX;
	const flow = new OpenAICodexOAuthFlow(options, pkce, originator, options.fetch ?? fetch);

	return flow.login();
}

export async function loginOpenAICodexDevice(ctrl: OAuthController): Promise<OAuthCredentials> {
	ctrl.onProgress?.("Initiating device authorization…");

	const initData = await withScopedTimeoutSignal(TOKEN_REQUEST_TIMEOUT_MS, async signal => {
		const initResponse = await fetch(DEVICE_USERCODE_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ client_id: CLIENT_ID }),
			signal,
		});

		if (!initResponse.ok) {
			throw new AIError.OAuthError(`Device authorization initiation failed: ${initResponse.status}`, {
				kind: "device-auth",
				status: initResponse.status,
			});
		}

		return (await initResponse.json()) as {
			device_auth_id?: string;
			user_code?: string;
			interval?: string | number;
		};
	});

	if (!initData.device_auth_id || !initData.user_code) {
		throw new AIError.OAuthError("Device authorization response missing required fields", { kind: "validation" });
	}

	const userCode = initData.user_code;
	const pollIntervalMs =
		(typeof initData.interval === "number"
			? initData.interval
			: parseInt(String(initData.interval ?? "5"), 10) || 5) *
			1000 +
		DEVICE_POLL_SAFETY_MARGIN_MS;

	ctrl.onAuth?.({
		url: DEVICE_AUTH_URL,
		instructions: `Enter code: ${userCode}`,
	});

	ctrl.onProgress?.(`Waiting for browser authorization (code: ${userCode})…`);

	for (let poll = 0; poll < DEVICE_MAX_POLLS; poll++) {
		await Bun.sleep(poll === 0 ? Math.min(pollIntervalMs, DEVICE_POLL_INTERVAL_MS) : pollIntervalMs);

		if (ctrl.signal?.aborted) {
			throw new AIError.LoginCancelledError("Device authorization cancelled");
		}

		const pollData = await withScopedTimeoutSignal(TOKEN_REQUEST_TIMEOUT_MS, async signal => {
			const pollResponse = await fetch(DEVICE_TOKEN_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					device_auth_id: initData.device_auth_id,
					user_code: userCode,
				}),
				signal,
			});

			if (pollResponse.status === 403 || pollResponse.status === 404) {
				return null;
			}

			if (!pollResponse.ok) {
				throw new AIError.OAuthError(`Device token polling failed: ${pollResponse.status}`, {
					kind: "polling",
					status: pollResponse.status,
				});
			}

			return (await pollResponse.json()) as {
				authorization_code?: string;
				code_verifier?: string;
			};
		});
		if (pollData === null) {
			continue;
		}

		if (!pollData.authorization_code || !pollData.code_verifier) {
			throw new AIError.OAuthError("Device token response missing authorization_code or code_verifier", {
				kind: "validation",
			});
		}

		ctrl.onProgress?.("Exchanging authorization code for tokens…");
		return exchangeCodeForToken(pollData.authorization_code, pollData.code_verifier, DEVICE_REDIRECT_URI);
	}

	throw new AIError.OAuthError("Device authorization timed out — user did not complete login in time", {
		kind: "timeout",
	});
}

export async function refreshOpenAICodexToken(refreshToken: string): Promise<OAuthCredentials> {
	const tokenData = await withScopedTimeoutSignal(TOKEN_REQUEST_TIMEOUT_MS, async signal => {
		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: CLIENT_ID,
			}),
			signal,
		});

		if (!response.ok) {
			const bodyText = await response.text();
			throw new AIError.OAuthError(
				`OpenAI Codex token refresh failed: ${formatOpenAICodexTokenEndpointError(response.status, bodyText)}`,
				{ kind: "token-refresh", status: response.status },
			);
		}

		return (await response.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
		};
	});

	if (!tokenData.access_token || !tokenData.refresh_token || typeof tokenData.expires_in !== "number") {
		throw new AIError.OAuthError("Token response missing required fields", { kind: "validation" });
	}

	const { accountId, email } = getTokenProfile(tokenData.access_token);

	return {
		access: tokenData.access_token,
		refresh: tokenData.refresh_token || refreshToken,
		expires: Date.now() + tokenData.expires_in * 1000,
		accountId: accountId ?? undefined,
		email,
	};
}
