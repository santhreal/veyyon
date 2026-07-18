// Device authorization and token refresh adapted from NousResearch/hermes-agent (MIT).

/**
 * xAI Grok OAuth device authorization flow.
 *
 * Requests an RFC 8628 device code, opens xAI's verification page, and polls
 * the discovered token endpoint until the user approves the login.
 */

import { errorMessage, scopedTimeoutSignal } from "@veyyon/utils";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { type OAuthDeviceCodePollResult, pollOAuthDeviceCodeFlow } from "./device-code";
import { emitOAuthSuccessPage } from "./success-page";
import type { OAuthController, OAuthCredentials } from "./types";

const XAI_OAUTH_ISSUER = "https://auth.x.ai";
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
const XAI_OAUTH_DEVICE_CODE_URL = `${XAI_OAUTH_ISSUER}/oauth2/device/code`;
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";

// Mirrors the 5-min skew used by anthropic.ts:160 — keeps every provider on the
// same conservative client-side expiry window.
const ACCESS_TOKEN_CLIENT_SKEW_MS = 5 * 60 * 1000;

const DISCOVERY_TIMEOUT_MS = 15_000;
const TOKEN_REQUEST_TIMEOUT_MS = 20_000;

interface XAIOAuthDiscovery {
	token_endpoint: string;
}

interface XAIDeviceAuthorization {
	deviceCode: string;
	userCode: string;
	verificationUriComplete: string;
	expiresInSeconds: number;
	intervalSeconds: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Validate an xAI OIDC endpoint against its scheme and host.
 *
 * The discovery response is long-lived and its token endpoint receives every
 * future refresh token. Rejecting non-HTTPS or non-`x.ai` / `*.x.ai` hosts
 * pins that endpoint to the xAI auth origin.
 *
 * @throws Error with message `Invalid xAI <field>: <url>` when the URL fails
 *         either scheme or host validation.
 */
export function validateXAIEndpoint(url: string, field: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new AIError.OAuthError(`Invalid xAI ${field}: ${url}`, { kind: "validation", provider: "xai" });
	}
	if (parsed.protocol !== "https:") {
		throw new AIError.OAuthError(`Invalid xAI ${field}: ${url}`, { kind: "validation", provider: "xai" });
	}
	const host = parsed.hostname.toLowerCase();
	if (!host || (host !== "x.ai" && !host.endsWith(".x.ai"))) {
		throw new AIError.OAuthError(`Invalid xAI ${field}: ${url}`, { kind: "validation", provider: "xai" });
	}
	return url;
}

/** Fetch xAI's OIDC discovery document and validate the token endpoint. */
async function xaiOAuthDiscovery(
	timeoutMs: number = DISCOVERY_TIMEOUT_MS,
	fetchOverride?: FetchImpl,
): Promise<XAIOAuthDiscovery> {
	// The scoped fence spans the body reads below and its timer is cleared
	// on settle (a bare AbortSignal.timeout stays armed for the full timeout).
	const requestTimeout = scopedTimeoutSignal(timeoutMs);
	try {
		const fetchImpl = fetchOverride ?? fetch;
		let response: Response;
		try {
			response = await fetchImpl(XAI_OAUTH_DISCOVERY_URL, {
				method: "GET",
				headers: { Accept: "application/json" },
				signal: requestTimeout.signal,
			});
		} catch (error) {
			throw new AIError.OAuthError(`xAI OIDC discovery failed: ${errorMessage(error)}`, {
				kind: "discovery",
				provider: "xai",
				cause: error,
			});
		}
		if (response.status !== 200) {
			throw new AIError.OAuthError(`xAI OIDC discovery returned status ${response.status}.`, {
				kind: "discovery",
				provider: "xai",
				status: response.status,
			});
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			throw new AIError.OAuthError(`xAI OIDC discovery returned invalid JSON: ${errorMessage(error)}`, {
				kind: "validation",
				provider: "xai",
				cause: error,
			});
		}
		if (!isRecord(payload)) {
			throw new AIError.OAuthError("xAI OIDC discovery response was not a JSON object.", {
				kind: "validation",
				provider: "xai",
			});
		}
		const tokenEndpoint = typeof payload.token_endpoint === "string" ? payload.token_endpoint.trim() : "";
		if (!tokenEndpoint) {
			throw new AIError.OAuthError("xAI OIDC discovery response was missing token_endpoint.", {
				kind: "validation",
				provider: "xai",
			});
		}
		validateXAIEndpoint(tokenEndpoint, "token_endpoint");
		return { token_endpoint: tokenEndpoint };
	} finally {
		requestTimeout.cancel();
	}
}

/**
 * Check whether a JWT access token is at or past its `exp` claim (with an
 * optional refresh-skew margin).
 *
 * Returns `false` for malformed input because this is a refresh-trigger check,
 * not token validation.
 */
export function isXAIAccessTokenExpiring(jwt: string, skewSeconds: number = 0): boolean {
	try {
		if (typeof jwt !== "string" || !jwt.includes(".")) return false;
		const parts = jwt.split(".");
		if (parts.length < 2) return false;
		const payloadPart = parts[1];
		if (!payloadPart) return false;
		const decoded = Buffer.from(payloadPart, "base64url").toString("utf8");
		const payload: unknown = JSON.parse(decoded);
		if (!isRecord(payload)) return false;
		const exp = payload.exp;
		if (typeof exp !== "number" || !Number.isFinite(exp)) return false;
		const now = Math.floor(Date.now() / 1000);
		const skew = Math.max(0, Math.floor(skewSeconds));
		return exp <= now + skew;
	} catch {
		return false;
	}
}

function parseXAIDeviceAuthorization(payload: unknown): XAIDeviceAuthorization {
	if (!isRecord(payload)) {
		throw new AIError.OAuthError("xAI device-code response was not a JSON object.", {
			kind: "validation",
			provider: "xai",
		});
	}

	const deviceCode = typeof payload.device_code === "string" ? payload.device_code.trim() : "";
	const userCode = typeof payload.user_code === "string" ? payload.user_code.trim() : "";
	const verificationUri = typeof payload.verification_uri === "string" ? payload.verification_uri.trim() : "";
	const verificationUriComplete =
		typeof payload.verification_uri_complete === "string" ? payload.verification_uri_complete.trim() : "";
	const expiresInSeconds = payload.expires_in;
	const intervalSeconds = payload.interval;
	if (
		!deviceCode ||
		!userCode ||
		!verificationUri ||
		!verificationUriComplete ||
		typeof expiresInSeconds !== "number" ||
		!Number.isFinite(expiresInSeconds) ||
		expiresInSeconds <= 0 ||
		typeof intervalSeconds !== "number" ||
		!Number.isFinite(intervalSeconds) ||
		intervalSeconds <= 0
	) {
		throw new AIError.OAuthError("xAI device-code response missing or invalid required fields.", {
			kind: "validation",
			provider: "xai",
		});
	}

	validateXAIEndpoint(verificationUri, "verification_uri");
	validateXAIEndpoint(verificationUriComplete, "verification_uri_complete");
	return {
		deviceCode,
		userCode,
		verificationUriComplete,
		expiresInSeconds,
		intervalSeconds,
	};
}

function parseXAITokenResponse(payload: unknown, label: string, refreshTokenFallback?: string): OAuthCredentials {
	if (!isRecord(payload)) {
		throw new AIError.OAuthError(`${label} was not a JSON object`, {
			kind: "validation",
			provider: "xai",
		});
	}
	const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
	const responseRefreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : "";
	const refreshToken = responseRefreshToken || refreshTokenFallback || "";
	const expiresInSeconds = payload.expires_in;
	if (!accessToken) {
		throw new AIError.OAuthError(`${label} missing access_token`, {
			kind: "validation",
			provider: "xai",
		});
	}
	if (!refreshToken) {
		throw new AIError.OAuthError(`${label} missing refresh_token`, {
			kind: "validation",
			provider: "xai",
		});
	}
	if (typeof expiresInSeconds !== "number" || !Number.isFinite(expiresInSeconds)) {
		throw new AIError.OAuthError(`${label} missing expires_in`, {
			kind: "validation",
			provider: "xai",
		});
	}
	return {
		access: accessToken,
		refresh: refreshToken,
		expires: Date.now() + expiresInSeconds * 1000 - ACCESS_TOKEN_CLIENT_SKEW_MS,
	};
}

async function requestXAIDeviceAuthorization(
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<XAIDeviceAuthorization> {
	// The scoped fence spans the body reads below and its timer is cleared
	// on settle (a bare AbortSignal.timeout stays armed for the full timeout).
	const requestTimeout = scopedTimeoutSignal(TOKEN_REQUEST_TIMEOUT_MS, signal);
	try {
		let response: Response;
		try {
			response = await fetchImpl(XAI_OAUTH_DEVICE_CODE_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Accept: "application/json",
				},
				body: new URLSearchParams({
					client_id: XAI_OAUTH_CLIENT_ID,
					scope: XAI_OAUTH_SCOPE,
				}),
				signal: requestTimeout.signal,
			});
		} catch (error) {
			if (signal?.aborted) throw new AIError.LoginCancelledError();
			throw new AIError.OAuthError(`xAI device-code request failed: ${errorMessage(error)}`, {
				kind: "device-auth",
				provider: "xai",
				cause: error,
			});
		}

		if (!response.ok) {
			let detail = "";
			try {
				detail = (await response.text()).trim();
			} catch {
				// Ignore body-read failures; the status code is the diagnostic.
			}
			throw new AIError.OAuthError(
				`xAI device-code request failed: ${response.status}${detail ? ` ${detail}` : ""}`,
				{
					kind: "device-auth",
					provider: "xai",
					status: response.status,
				},
			);
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			throw new AIError.OAuthError(`xAI device-code response returned invalid JSON: ${errorMessage(error)}`, {
				kind: "validation",
				provider: "xai",
				cause: error,
			});
		}
		return parseXAIDeviceAuthorization(payload);
	} finally {
		requestTimeout.cancel();
	}
}

async function pollXAIDeviceToken(
	tokenEndpoint: string,
	deviceCode: string,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<OAuthDeviceCodePollResult<OAuthCredentials>> {
	// The scoped fence spans the body reads below and its timer is cleared
	// on settle (a bare AbortSignal.timeout stays armed for the full timeout).
	const requestTimeout = scopedTimeoutSignal(TOKEN_REQUEST_TIMEOUT_MS, signal);
	try {
		let response: Response;
		try {
			response = await fetchImpl(tokenEndpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Accept: "application/json",
				},
				body: new URLSearchParams({
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					client_id: XAI_OAUTH_CLIENT_ID,
					device_code: deviceCode,
				}),
				signal: requestTimeout.signal,
			});
		} catch (error) {
			if (signal?.aborted) throw new AIError.LoginCancelledError();
			throw new AIError.OAuthError(`xAI device-code token polling failed: ${errorMessage(error)}`, {
				kind: "polling",
				provider: "xai",
				cause: error,
			});
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			throw new AIError.OAuthError(`xAI device-code token polling returned invalid JSON: ${errorMessage(error)}`, {
				kind: "polling",
				provider: "xai",
				status: response.status,
				cause: error,
			});
		}

		if (response.ok) {
			return {
				status: "complete",
				value: parseXAITokenResponse(payload, "xAI device-code token response"),
			};
		}
		if (!isRecord(payload)) {
			throw new AIError.OAuthError(`xAI device-code token polling failed: ${response.status}`, {
				kind: "polling",
				provider: "xai",
				status: response.status,
			});
		}

		const errorCode = typeof payload.error === "string" ? payload.error : "";
		if (errorCode === "authorization_pending") return { status: "pending" };
		if (errorCode === "slow_down") return { status: "slow_down" };

		const errorDescription = typeof payload.error_description === "string" ? payload.error_description : "";
		const detail = errorDescription || errorCode || String(response.status);
		throw new AIError.OAuthError(`xAI device-code token polling failed: ${detail}`, {
			kind: "polling",
			provider: "xai",
			status: response.status,
		});
	} finally {
		requestTimeout.cancel();
	}
}

/** Log in to xAI Grok with the RFC 8628 device authorization grant. */
export async function loginXAIOAuth(ctrl: OAuthController): Promise<OAuthCredentials> {
	const fetchImpl = ctrl.fetch ?? fetch;
	const discovery = await xaiOAuthDiscovery(DISCOVERY_TIMEOUT_MS, fetchImpl);
	const device = await requestXAIDeviceAuthorization(fetchImpl, ctrl.signal);
	ctrl.onAuth?.({
		url: device.verificationUriComplete,
		instructions: `Enter code: ${device.userCode}`,
	});
	ctrl.onProgress?.("Waiting for xAI device authorization...");

	const credentials = await pollOAuthDeviceCodeFlow({
		poll: () => pollXAIDeviceToken(discovery.token_endpoint, device.deviceCode, fetchImpl, ctrl.signal),
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
		signal: ctrl.signal,
	});
	// Device-code flows get no browser redirect of their own; bring up the
	// branded success page so grok ends on the same screen as callback providers.
	emitOAuthSuccessPage(ctrl);
	return credentials;
}

/**
 * Refresh an xAI OAuth access token using a stored refresh_token.
 *
 * Re-runs OIDC discovery and re-validates the token endpoint before sending
 * the stored refresh token.
 */
export async function refreshXAIOAuthToken(refreshToken: string, fetchOverride?: FetchImpl): Promise<OAuthCredentials> {
	const fetchImpl = fetchOverride ?? fetch;
	if (typeof refreshToken !== "string" || !refreshToken.trim()) {
		throw new AIError.OAuthError("missing refresh_token", { kind: "validation", provider: "xai" });
	}

	const discovery = await xaiOAuthDiscovery(DISCOVERY_TIMEOUT_MS, fetchImpl);
	const tokenEndpoint = validateXAIEndpoint(discovery.token_endpoint, "token_endpoint");

	const body = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: XAI_OAUTH_CLIENT_ID,
		refresh_token: refreshToken,
	});

	// The scoped fence covers only the refresh request (discovery has its own),
	// spans the body reads, and clears its timer on settle (a bare
	// AbortSignal.timeout stays armed for the full timeout).
	const requestTimeout = scopedTimeoutSignal(TOKEN_REQUEST_TIMEOUT_MS);
	try {
		const response = await fetchImpl(tokenEndpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body,
			signal: requestTimeout.signal,
		});

		if (!response.ok) {
			let detail = "";
			try {
				detail = (await response.text()).trim();
			} catch {
				// Ignore body-read failures; the status code is the diagnostic.
			}
			throw new AIError.OAuthError(`xAI token refresh failed: ${response.status}${detail ? ` ${detail}` : ""}`, {
				kind: "token-refresh",
				provider: "xai",
				status: response.status,
			});
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			throw new AIError.OAuthError(`xAI token refresh returned invalid JSON: ${errorMessage(error)}`, {
				kind: "validation",
				provider: "xai",
				cause: error,
			});
		}
		return parseXAITokenResponse(payload, "xAI token refresh response", refreshToken);
	} finally {
		requestTimeout.cancel();
	}
}
