import { decodeJwtPayload } from "@veyyon/utils/jwt";

export const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

export const CODEX_CLIENT_VERSION = "0.144.1";

export const OPENAI_HEADERS = {
	BETA: "OpenAI-Beta",
	ACCOUNT_ID: "chatgpt-account-id",
	ORIGINATOR: "originator",
	VERSION: "version",
	SESSION_ID: "session_id",
	CONVERSATION_ID: "conversation_id",
	SCOPED_SESSION_ID: "session-id",
	THREAD_ID: "thread-id",
	INSTALLATION_ID: "x-codex-installation-id",
	WINDOW_ID: "x-codex-window-id",
	TURN_METADATA: "x-codex-turn-metadata",
	PARENT_THREAD_ID: "x-codex-parent-thread-id",
	SUBAGENT: "x-openai-subagent",
	RESPONSES_LITE: "x-openai-internal-codex-responses-lite",
} as const;

export const OPENAI_HEADER_VALUES = {
	BETA_RESPONSES: "responses=experimental",
	BETA_RESPONSES_WEBSOCKETS_V2: "responses_websockets=2026-02-06",
	ORIGINATOR_CODEX: "pi",
} as const;

export const URL_PATHS = {
	RESPONSES: "/responses",
	CODEX_RESPONSES: "/codex/responses",
} as const;

export const CODEX_JWT_AUTH_CLAIM = "https://api.openai.com/auth" as const;
export const JWT_CLAIM_PATH = CODEX_JWT_AUTH_CLAIM;
export const CODEX_JWT_PROFILE_CLAIM = "https://api.openai.com/profile" as const;

export interface CodexTokenIdentity {
	accountId?: string;
	email?: string;
}

function usableClaim(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
export function readCodexClaimsFromPayload(payload: Record<string, unknown>): CodexTokenIdentity {
	const auth = payload[CODEX_JWT_AUTH_CLAIM];
	const profile = payload[CODEX_JWT_PROFILE_CLAIM];
	const accountId =
		auth !== null && typeof auth === "object"
			? usableClaim((auth as Record<string, unknown>).chatgpt_account_id)
			: undefined;
	const rawEmail =
		profile !== null && typeof profile === "object"
			? usableClaim((profile as Record<string, unknown>).email)
			: undefined;
	return { accountId, email: rawEmail?.toLowerCase() };
}

export function readCodexTokenIdentity(accessToken: string | undefined): CodexTokenIdentity {
	if (!accessToken) return {};
	const payload = decodeJwtPayload(accessToken);
	if (!payload) return {};
	return readCodexClaimsFromPayload(payload);
}

export function getCodexAccountId(accessToken: string | undefined): string | undefined {
	return readCodexTokenIdentity(accessToken).accountId;
}

export function getCodexAccountEmail(accessToken: string | undefined): string | undefined {
	return readCodexTokenIdentity(accessToken).email;
}
