import { type CodexTokenIdentity, OPENAI_HEADER_VALUES, readCodexTokenIdentity } from "@veyyon/catalog/wire/codex";
import { isRecord } from "../../utils";

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CALLBACK_PORT = 1455;
export const CALLBACK_PATH = "/auth/callback";
export const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
export const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
export const DEVICE_USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
export const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
export const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
export const DEVICE_AUTH_URL = "https://auth.openai.com/codex/device";
export const DEVICE_POLL_INTERVAL_MS = 5_000;
export const DEVICE_POLL_SAFETY_MARGIN_MS = 3_000;
export const DEVICE_MAX_POLLS = 120;

export function getTokenProfile(accessToken: string): CodexTokenIdentity {
	return readCodexTokenIdentity(accessToken);
}

export interface PKCE {
	verifier: string;
	challenge: string;
}
function describeTokenEndpointValue(value: unknown): string | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (!isRecord(value)) return undefined;

	const code = describeTokenEndpointValue(value.code ?? value.error);
	const message = describeTokenEndpointValue(value.message ?? value.error_description ?? value.description);
	if (code && message && code !== message) return `${code}: ${message}`;
	return code ?? message ?? JSON.stringify(value);
}

export function formatOpenAICodexTokenEndpointError(status: number, bodyText: string): string {
	const trimmed = bodyText.trim();
	if (trimmed.length === 0) return `${status}`;

	try {
		const body: unknown = JSON.parse(trimmed);
		if (!isRecord(body)) return `${status} ${trimmed}`;

		const error = describeTokenEndpointValue(body.error);
		const description = describeTokenEndpointValue(body.error_description);
		if (error && description && error !== description) return `${status} ${error}: ${description}`;
		return `${status} ${error ?? description ?? describeTokenEndpointValue(body.message) ?? trimmed}`;
	} catch {
		return `${status} ${trimmed}`;
	}
}
export function createOpenAICodexAuthorizationUrl(args: {
	state: string;
	redirectUri: string;
	challenge: string;
	originator?: string;
}): string {
	const originator = args.originator?.trim() || OPENAI_HEADER_VALUES.ORIGINATOR_CODEX;
	const searchParams = new URLSearchParams({
		response_type: "code",
		client_id: CLIENT_ID,
		redirect_uri: args.redirectUri,
		scope: SCOPE,
		code_challenge: args.challenge,
		code_challenge_method: "S256",
		state: args.state,
		id_token_add_organizations: "true",
		codex_cli_simplified_flow: "true",
		originator,
	});

	return `${AUTHORIZE_URL}?${searchParams.toString()}`;
}
