import { decodeJwtPayload } from "@veyyon/utils/jwt";
import { isRecord } from "@veyyon/utils/type-guards";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { pollOAuthDeviceCodeFlow } from "./device-code";
import { credentialExpiryFromExpiresIn, credentialExpiryFromJwtExp } from "./expiry";
import { emitOAuthSuccessPage } from "./success-page";
import type { OAuthController, OAuthCredentials } from "./types";

export const NOUS_PORTAL_URL = "https://portal.nousresearch.com";
export const NOUS_DEVICE_CODE_URL = `${NOUS_PORTAL_URL}/api/oauth/device/code`;
export const NOUS_TOKEN_URL = `${NOUS_PORTAL_URL}/api/oauth/token`;
export const NOUS_CLIENT_ID = "hermes-cli";
export const NOUS_INFERENCE_SCOPE = "inference:invoke";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const ACCESS_TOKEN_REFRESH_SKEW_MS = 120_000;
const PROVIDER_ID = "nous-research";

interface DeviceCodeResponse {
	device_code?: unknown;
	user_code?: unknown;
	verification_uri?: unknown;
	verification_uri_complete?: unknown;
	expires_in?: unknown;
	interval?: unknown;
}

interface TokenResponse {
	access_token?: unknown;
	refresh_token?: unknown;
	expires_in?: unknown;
	scope?: unknown;
	error?: unknown;
	error_description?: unknown;
}

interface NousJwtClaims {
	exp?: unknown;
	scope?: unknown;
	scp?: unknown;
}

interface DeviceAuthorization {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete: string;
	expiresInSeconds: number;
	intervalSeconds: number;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function oauthErrorDetail(payload: TokenResponse): string {
	return [payload.error, payload.error_description]
		.filter(isNonEmptyString)
		.map(value => value.trim())
		.join(": ");
}

function containsScope(value: unknown, expected: string): boolean {
	if (typeof value === "string") {
		return value
			.replaceAll(",", " ")
			.split(/\s+/)
			.some(scope => scope === expected);
	}
	if (Array.isArray(value)) {
		return value.some(item => containsScope(item, expected));
	}
	return false;
}

/**
 * The body of a Nous Portal response, or the reason there is no usable body.
 *
 * The status is read BEFORE the parse failure is reported. Every caller here parses the body
 * before it looks at `response.ok`, because a Portal error arrives as a JSON `error` field on a
 * 4xx. A gateway in front of the Portal does not play along: a 502 or a 503 answers with an HTML
 * page, and reporting that as "returned invalid JSON" of kind `validation` describes the operator's
 * request as malformed when the Portal was never reached. The status is what happened, so a failed
 * response says so and keeps the parse failure as its cause.
 */
async function responseJson<T>(response: Response, operation: string): Promise<T> {
	try {
		return (await response.json()) as T;
	} catch (cause) {
		if (!response.ok) {
			const reason = response.statusText ? ` ${response.statusText}` : "";
			throw new AIError.OAuthError(`Nous Portal ${operation} failed: ${response.status}${reason}`, {
				kind: "http",
				provider: PROVIDER_ID,
				status: response.status,
				cause,
			});
		}
		throw new AIError.OAuthError(`Nous Portal ${operation} returned invalid JSON`, {
			kind: "validation",
			provider: PROVIDER_ID,
			status: response.status,
			cause,
		});
	}
}

function parseTokenResponse(payload: TokenResponse, refreshTokenFallback?: string): OAuthCredentials {
	if (!isNonEmptyString(payload.access_token)) {
		throw new AIError.OAuthError("Nous Portal token response missing access_token", {
			kind: "validation",
			provider: PROVIDER_ID,
		});
	}
	const access = payload.access_token.trim();
	const refresh = isNonEmptyString(payload.refresh_token)
		? payload.refresh_token.trim()
		: refreshTokenFallback?.trim();
	if (!refresh) {
		throw new AIError.OAuthError("Nous Portal token response missing refresh_token", {
			kind: "validation",
			provider: PROVIDER_ID,
		});
	}

	const decodedClaims = decodeJwtPayload<unknown>(access);
	if (!isRecord(decodedClaims)) {
		throw new AIError.OAuthError("Nous Portal access_token is not an inference JWT", {
			kind: "validation",
			provider: PROVIDER_ID,
		});
	}
	const claims = decodedClaims as NousJwtClaims;
	if (![payload.scope, claims.scope, claims.scp].some(value => containsScope(value, NOUS_INFERENCE_SCOPE))) {
		throw new AIError.OAuthError(`Nous Portal access_token is missing ${NOUS_INFERENCE_SCOPE} scope`, {
			kind: "validation",
			provider: PROVIDER_ID,
		});
	}

	const issuedAtMs = Date.now();
	const expires =
		typeof claims.exp === "number"
			? credentialExpiryFromJwtExp(claims.exp, {
					provider: PROVIDER_ID,
					skewMs: ACCESS_TOKEN_REFRESH_SKEW_MS,
				})
			: credentialExpiryFromExpiresIn(payload.expires_in, {
					provider: PROVIDER_ID,
					issuedAtMs,
					skewMs: ACCESS_TOKEN_REFRESH_SKEW_MS,
				});
	if (expires <= issuedAtMs) {
		throw new AIError.OAuthError("Nous Portal access_token is expired or too close to expiry", {
			kind: "validation",
			provider: PROVIDER_ID,
		});
	}

	return { access, refresh, expires };
}

async function requestDeviceAuthorization(fetchImpl: FetchImpl, signal?: AbortSignal): Promise<DeviceAuthorization> {
	let response: Response;
	try {
		response = await fetchImpl(NOUS_DEVICE_CODE_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ client_id: NOUS_CLIENT_ID, scope: NOUS_INFERENCE_SCOPE }),
			signal,
		});
	} catch (cause) {
		if (signal?.aborted) throw new AIError.LoginCancelledError();
		throw new AIError.OAuthError(
			"Could not start Nous Portal login. Check the network connection, then retry the browser or headless login.",
			{ kind: "device-auth", provider: PROVIDER_ID, cause },
		);
	}
	if (!response.ok) {
		const detail = await AIError.readProviderErrorDetail(response);
		throw new AIError.OAuthError(
			`Nous Portal device authorization failed: ${response.status}${detail ? `: ${detail}` : ""}`,
			{ kind: "device-auth", provider: PROVIDER_ID, status: response.status },
		);
	}

	const payload = await responseJson<DeviceCodeResponse>(response, "device authorization");
	if (
		!isNonEmptyString(payload.device_code) ||
		!isNonEmptyString(payload.user_code) ||
		!isNonEmptyString(payload.verification_uri) ||
		!isPositiveFiniteNumber(payload.expires_in) ||
		!isPositiveFiniteNumber(payload.interval)
	) {
		throw new AIError.OAuthError("Nous Portal device authorization response missing required fields", {
			kind: "validation",
			provider: PROVIDER_ID,
		});
	}
	const verificationUri = payload.verification_uri.trim();
	return {
		deviceCode: payload.device_code.trim(),
		userCode: payload.user_code.trim(),
		verificationUri,
		// RFC 8628 marks `verification_uri_complete` optional. Without it the
		// user opens the plain URI and types the code shown beside it.
		verificationUriComplete: isNonEmptyString(payload.verification_uri_complete)
			? payload.verification_uri_complete.trim()
			: verificationUri,
		expiresInSeconds: payload.expires_in,
		intervalSeconds: payload.interval,
	};
}

async function pollForToken(
	device: DeviceAuthorization,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	return pollOAuthDeviceCodeFlow<OAuthCredentials>({
		// RFC 8628 `interval` is a floor, not a ceiling. `pollOAuthDeviceCodeFlow`
		// enforces its own 1s minimum and 5s default.
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
		signal,
		poll: async () => {
			let response: Response;
			try {
				response = await fetchImpl(NOUS_TOKEN_URL, {
					method: "POST",
					headers: {
						Accept: "application/json",
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body: new URLSearchParams({
						grant_type: DEVICE_CODE_GRANT,
						client_id: NOUS_CLIENT_ID,
						device_code: device.deviceCode,
					}),
					signal,
				});
			} catch (cause) {
				if (signal?.aborted) throw new AIError.LoginCancelledError();
				throw new AIError.OAuthError("Nous Portal device token request failed", {
					kind: "polling",
					provider: PROVIDER_ID,
					cause,
				});
			}

			const payload = await responseJson<TokenResponse>(response, "device token exchange");
			if (response.ok) return { status: "complete", value: parseTokenResponse(payload) };
			if (payload.error === "authorization_pending") return { status: "pending" };
			if (payload.error === "slow_down") return { status: "slow_down" };
			const detail = oauthErrorDetail(payload);
			return {
				status: "failed",
				message: `Nous Portal device authorization failed: ${detail || response.status}`,
			};
		},
	});
}

export async function loginNousResearch(options: OAuthController): Promise<OAuthCredentials> {
	if (!options.onAuth) {
		throw new AIError.OAuthError(
			"Nous Portal login requires an onAuth callback to show the verification URL in browser and headless sessions",
			{ kind: "configuration", provider: PROVIDER_ID },
		);
	}
	const fetchImpl = options.fetch ?? fetch;
	const device = await requestDeviceAuthorization(fetchImpl, options.signal);
	options.onAuth({
		url: device.verificationUriComplete,
		instructions:
			`Open the URL in a browser and enter code ${device.userCode} if prompted. ` +
			`If no browser opens or this is a headless/remote session, copy the URL into any browser (${device.verificationUri}).`,
	});
	options.onProgress?.("Waiting for Nous Portal authorization...");
	const credentials = await pollForToken(device, fetchImpl, options.signal);
	emitOAuthSuccessPage(options);
	return credentials;
}

export async function refreshNousResearchToken(
	credentials: OAuthCredentials,
	fetchImpl: FetchImpl = fetch,
): Promise<OAuthCredentials> {
	const refreshToken = credentials.refresh.trim();
	if (!refreshToken) {
		throw new AIError.OAuthError("Nous Portal refresh token is missing; sign in again", {
			kind: "validation",
			provider: PROVIDER_ID,
		});
	}

	let response: Response;
	try {
		response = await fetchImpl(NOUS_TOKEN_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
				"x-nous-refresh-token": refreshToken,
			},
			body: new URLSearchParams({ grant_type: "refresh_token", client_id: NOUS_CLIENT_ID }),
		});
	} catch (cause) {
		throw new AIError.OAuthError("Nous Portal token refresh request failed", {
			kind: "token-refresh",
			provider: PROVIDER_ID,
			cause,
		});
	}
	const payload = await responseJson<TokenResponse>(response, "token refresh");
	if (!response.ok) {
		const detail = oauthErrorDetail(payload);
		throw new AIError.OAuthError(
			`Nous Portal token refresh failed: ${response.status}${detail ? `: ${detail}` : ""}`,
			{ kind: "token-refresh", provider: PROVIDER_ID, status: response.status },
		);
	}
	return parseTokenResponse(payload, refreshToken);
}

export function getNousResearchApiKey(credentials: OAuthCredentials): string {
	return credentials.access;
}
