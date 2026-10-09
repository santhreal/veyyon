/**
 * Kimi Code OAuth flow (device authorization grant)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import {
	KIMI_CODE_REGIONS,
	type KimiCodeRegion,
	kimiCodeApiEndpointOf,
	kimiCodeRegionOfApiEndpoint,
	kimiCodeRegionOfOAuthHost,
} from "@veyyon/catalog/wire/kimi-code";
import { getAgentDir } from "@veyyon/utils/dirs";
import { $env } from "@veyyon/utils/env";
import { isEnoent } from "@veyyon/utils/fs-error";
import packageJson from "../../../package.json" with { type: "json" };
import * as AIError from "../../error";
import { credentialExpiryFromExpiresIn } from "./expiry";
import { emitOAuthSuccessPage } from "./success-page";
import type { OAuthController, OAuthCredentials } from "./types";

// One client id serves both regions; only the hosts differ.
const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEVICE_ID_FILENAME = "kimi-device-id";
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_DEVICE_FLOW_TTL_MS = 15 * 60 * 1000;

interface DeviceAuthorizationResponse {
	user_code?: string;
	device_code?: string;
	verification_uri?: string;
	verification_uri_complete?: string;
	expires_in?: number;
	interval?: number;
}

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
	token_type?: string;
	error?: string;
	error_description?: string;
	interval?: number;
}

/** The OAuth host for `region`. `KIMI_CODE_OAUTH_HOST` and `KIMI_OAUTH_HOST` override both regions. */
function resolveOAuthHost(region: KimiCodeRegion): string {
	return $env.KIMI_CODE_OAUTH_HOST || $env.KIMI_OAUTH_HOST || KIMI_CODE_REGIONS[region].oauthHost;
}

function formatDeviceModel(system: string, release: string, arch: string): string {
	return [system, release, arch].filter(Boolean).join(" ").trim();
}

function getDeviceModel(): string {
	const platform = os.platform();
	const release = os.release();
	const arch = os.arch();
	if (platform === "darwin") return formatDeviceModel("macOS", release, arch);
	if (platform === "win32") return formatDeviceModel("Windows", release, arch);
	const label = platform === "linux" ? "Linux" : platform;
	return formatDeviceModel(label, release, arch);
}

let getDeviceId = (): string => {
	const deviceIdPath = path.join(getAgentDir(), DEVICE_ID_FILENAME);
	try {
		const existing = fs.readFileSync(deviceIdPath, "utf-8");
		const trimmed = existing.trim();
		if (trimmed) {
			getDeviceId = () => trimmed;
			return trimmed;
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	const deviceId = crypto.randomUUID().replace(/-/g, "");
	// getAgentDir() only names the config root; it does not guarantee the
	// directory exists on disk. On a fresh host (a clean CI runner, a
	// first-ever launch) the parent is absent, so the write below would throw
	// ENOENT. That error used to propagate up through getKimiCommonHeaders()
	// into the usage/OAuth request try-blocks and get swallowed as a null
	// "usage unavailable", masking a filesystem failure as a network one.
	// Create the parent first so the device-id file is always writable.
	fs.mkdirSync(path.dirname(deviceIdPath), { recursive: true });
	fs.writeFileSync(deviceIdPath, `${deviceId}\n`, { mode: 0o600 });
	getDeviceId = () => deviceId;
	return deviceId;
};

function sanitizeHeaderValue(value: string, fallback = ""): string {
	const sanitized = value.replace(/[^\x20-\x7E]/g, "").trim();
	return sanitized || fallback;
}

export let getKimiCommonHeaders = () => {
	const headers = Object.freeze({
		"User-Agent": `KimiCLI/${packageJson.version}`,
		"X-Msh-Platform": "kimi_cli",
		"X-Msh-Version": packageJson.version,
		"X-Msh-Device-Name": sanitizeHeaderValue(os.hostname(), "unknown"),
		"X-Msh-Device-Model": sanitizeHeaderValue(getDeviceModel(), "unknown"),
		"X-Msh-Os-Version": sanitizeHeaderValue(os.version(), "unknown"),
		"X-Msh-Device-Id": sanitizeHeaderValue(getDeviceId(), "unknown"),
	});
	getKimiCommonHeaders = () => headers;
	return headers;
};

async function requestDeviceAuthorization(oauthHost: string): Promise<{
	userCode: string;
	deviceCode: string;
	verificationUri: string;
	verificationUriComplete: string;
	expiresInMs: number;
	intervalMs: number;
}> {
	const response = await fetch(`${oauthHost}/api/oauth/device_authorization`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			...getKimiCommonHeaders(),
		},
		body: new URLSearchParams({ client_id: CLIENT_ID }),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new AIError.OAuthError(`Kimi device authorization failed: ${response.status} ${text}`, {
			kind: "device-auth",
			provider: "kimi",
			status: response.status,
		});
	}

	const payload = (await response.json()) as DeviceAuthorizationResponse;
	const userCode = payload.user_code;
	const deviceCode = payload.device_code;
	const verificationUri = payload.verification_uri;
	const verificationUriComplete = payload.verification_uri_complete;

	if (!userCode || !deviceCode || !verificationUri) {
		throw new AIError.OAuthError("Kimi device authorization response missing required fields", {
			kind: "validation",
			provider: "kimi",
		});
	}

	const expiresInMs = typeof payload.expires_in === "number" ? payload.expires_in * 1000 : DEFAULT_DEVICE_FLOW_TTL_MS;
	const intervalMs =
		typeof payload.interval === "number" && payload.interval > 0 ? payload.interval * 1000 : DEFAULT_POLL_INTERVAL_MS;

	return {
		userCode,
		deviceCode,
		verificationUri,
		verificationUriComplete: verificationUriComplete || verificationUri,
		expiresInMs,
		intervalMs,
	};
}

/** The credential a granting token response describes, scoped to the region named by `apiEndpoint`. */
function parseTokenPayload(
	payload: TokenResponse,
	apiEndpoint: string | undefined,
	refreshTokenFallback?: string,
): OAuthCredentials {
	if (!payload.access_token || typeof payload.expires_in !== "number") {
		throw new AIError.OAuthError("Kimi token response missing required fields", {
			kind: "validation",
			provider: "kimi",
		});
	}

	const refresh = payload.refresh_token ?? refreshTokenFallback;
	if (!refresh) {
		throw new AIError.OAuthError("Kimi token response missing refresh token", {
			kind: "validation",
			provider: "kimi",
		});
	}

	return {
		access: payload.access_token,
		refresh,
		expires: credentialExpiryFromExpiresIn(payload.expires_in, { provider: "kimi" }),
		...(apiEndpoint !== undefined && { apiEndpoint }),
	};
}

// The wait before the next poll after a non-token response; throws when the device flow cannot continue.
function nextPollWaitMs(payload: TokenResponse, status: number, waitMs: number): number {
	switch (payload.error) {
		case "authorization_pending":
			return waitMs;
		case "slow_down": {
			const slowedMs = waitMs + 5000;
			const retryAfterMs = typeof payload.interval === "number" ? payload.interval * 1000 : undefined;
			return retryAfterMs && retryAfterMs > slowedMs ? retryAfterMs : slowedMs;
		}
		case "expired_token":
			throw new AIError.OAuthError("Kimi device authorization expired", { kind: "validation", provider: "kimi" });
		case "access_denied":
			throw new AIError.OAuthError("Kimi device authorization denied", { kind: "validation", provider: "kimi" });
	}
	const description = payload.error_description ? `: ${payload.error_description}` : "";
	throw new AIError.OAuthError(`Kimi device flow failed: ${payload.error ?? status}${description}`, {
		kind: "polling",
		provider: "kimi",
	});
}

/** Poll `oauthHost` until it grants a token, and return the granting response. */
async function pollForToken(
	oauthHost: string,
	deviceCode: string,
	intervalMs: number,
	expiresInMs: number,
	signal?: AbortSignal,
): Promise<TokenResponse> {
	const deadline = Date.now() + expiresInMs;
	let waitMs = Math.max(1000, intervalMs);

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new AIError.LoginCancelledError();
		}

		const response = await fetch(`${oauthHost}/api/oauth/token`, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				...getKimiCommonHeaders(),
			},
			body: new URLSearchParams({
				client_id: CLIENT_ID,
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
		});

		const payload = (await response.json()) as TokenResponse;
		if (response.ok && payload.access_token) {
			return payload;
		}
		waitMs = nextPollWaitMs(payload, response.status, waitMs);
		await scheduler.wait(waitMs, { signal });
	}

	throw new AIError.OAuthError("Kimi device flow timed out", {
		kind: "timeout",
		provider: "kimi",
	});
}

/**
 * Login with Kimi Code OAuth (device code flow) at the deployment of `region`: `mainland-cn` signs in
 * at kimi.com, `global` at kimi.ai. An OAuth host set in the environment overrides the region's host,
 * and the credential records the deployment of that host, or `region` when the host is neither's.
 */
export async function loginKimi(options: OAuthController, region: KimiCodeRegion): Promise<OAuthCredentials> {
	const oauthHost = resolveOAuthHost(region);
	const device = await requestDeviceAuthorization(oauthHost);
	options.onAuth?.({
		url: device.verificationUriComplete,
		instructions: `Enter code: ${device.userCode}`,
	});

	const granted = await pollForToken(
		oauthHost,
		device.deviceCode,
		device.intervalMs,
		device.expiresInMs,
		options.signal,
	);
	const credentials = parseTokenPayload(
		granted,
		kimiCodeApiEndpointOf(kimiCodeRegionOfOAuthHost(oauthHost) ?? region),
	);
	// Device-code flow has no browser redirect; show the branded success page.
	emitOAuthSuccessPage(options);
	return credentials;
}

/**
 * Refresh a Kimi OAuth token at the OAuth host of the region the credential's `apiEndpoint` names, so
 * a kimi.ai credential is never posted to kimi.com.
 */
export async function refreshKimiToken(
	refreshToken: string,
	apiEndpoint: string | undefined,
): Promise<OAuthCredentials> {
	const region = kimiCodeRegionOfApiEndpoint(apiEndpoint);
	const response = await fetch(`${resolveOAuthHost(region)}/api/oauth/token`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			...getKimiCommonHeaders(),
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: CLIENT_ID,
		}),
	});

	if (!response.ok) {
		const payload = (await response.json().catch(() => undefined)) as TokenResponse | undefined;
		// Carry the machine-readable `error` code, not only the prose
		// `error_description`. `isDefinitiveOAuthFailure` keys on codes such as
		// `invalid_grant` to decide whether a refresh failure means the grant is
		// dead (disable the credential, tell the user to log in again) or merely
		// transient (retry). Kimi returns 400 with `error: "invalid_grant"` and
		// `error_description: "The provided authorization grant is invalid"`, and
		// dropping the code left only prose that matched neither the definitive
		// pattern nor the 401 fallback. Every dead kimi grant was therefore
		// classified transient: the row was blocked for five minutes, never
		// disabled, and the session reported "signed in, but could not get a
		// usable token right now (for example a lapsed subscription)" on a loop
		// instead of "your login expired, run /login".
		const detail = [payload?.error, payload?.error_description].filter(Boolean).join(": ");
		throw new AIError.OAuthError(`Kimi token refresh failed: ${response.status}${detail ? `: ${detail}` : ""}`, {
			kind: "token-refresh",
			provider: "kimi",
			status: response.status,
		});
	}

	const payload = (await response.json()) as TokenResponse;
	return parseTokenPayload(payload, kimiCodeApiEndpointOf(region), refreshToken);
}
