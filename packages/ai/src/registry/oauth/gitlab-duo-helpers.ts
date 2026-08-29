import * as AIError from "../../error";
import { DEFAULT_CALLBACK_PATH, type OAuthCallbackFlowOptions } from "./callback-server";
import { credentialExpiryFromExpiresIn } from "./expiry";
import type { OAuthCredentials } from "./types";

export const DEFAULT_CLIENT_ID = "da4edff2e6ebd2bc3208611e2768bc1c1dd7be791dc5ff26ca34ca9ee44f7d4b";
export const OAUTH_SCOPES = ["api"];
export const DEFAULT_CALLBACK_PORT = 8080;
export const DEFAULT_CALLBACK_HOSTNAME = "localhost";

export interface PKCEPair {
	verifier: string;
	challenge: string;
}

export function resolveClientId(): string {
	const env = process.env.GITLAB_CLIENT_ID?.trim();
	return env && env.length > 0 ? env : DEFAULT_CLIENT_ID;
}

export function resolveCallbackOptions(): OAuthCallbackFlowOptions {
	const raw = process.env.GITLAB_REDIRECT_URI?.trim();
	if (!raw) {
		return {
			preferredPort: DEFAULT_CALLBACK_PORT,
			callbackPath: DEFAULT_CALLBACK_PATH,
			callbackHostname: DEFAULT_CALLBACK_HOSTNAME,
		};
	}

	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new AIError.OAuthError(`Invalid GITLAB_REDIRECT_URI: ${raw}`, {
			kind: "configuration",
			provider: "gitlab-duo",
		});
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new AIError.OAuthError(`GITLAB_REDIRECT_URI must use http:// or https://, got: ${raw}`, {
			kind: "configuration",
			provider: "gitlab-duo",
		});
	}

	const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
	if (isLoopback && parsed.protocol !== "http:") {
		throw new AIError.OAuthError(`GITLAB_REDIRECT_URI loopback callbacks must use http://, got: ${raw}`, {
			kind: "configuration",
			provider: "gitlab-duo",
		});
	}

	const port = parsed.port ? Number.parseInt(parsed.port, 10) : parsed.protocol === "https:" ? 443 : 80;

	return {
		preferredPort: isLoopback ? port : 0,
		callbackPath: parsed.pathname || DEFAULT_CALLBACK_PATH,
		callbackHostname: isLoopback ? parsed.hostname : DEFAULT_CALLBACK_HOSTNAME,
		redirectUri: raw,
	};
}

export function mapTokenResponse(payload: {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	created_at?: number;
}): OAuthCredentials {
	if (!payload.access_token || !payload.refresh_token || typeof payload.expires_in !== "number") {
		throw new AIError.OAuthError("GitLab OAuth token response missing required fields", {
			kind: "validation",
			provider: "gitlab-duo",
		});
	}

	const createdAtMs =
		typeof payload.created_at === "number" && Number.isFinite(payload.created_at)
			? payload.created_at * 1000
			: Date.now();

	return {
		access: payload.access_token,
		refresh: payload.refresh_token,
		expires: credentialExpiryFromExpiresIn(payload.expires_in, { issuedAtMs: createdAtMs, provider: "gitlab-duo" }),
	};
}
