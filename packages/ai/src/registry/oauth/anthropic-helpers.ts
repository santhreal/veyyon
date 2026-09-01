import { CLAUDE_CODE_VERSION as claudeCodeVersion } from "@veyyon/catalog/wire/anthropic";
import { withScopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";

export const decode = (s: string) => atob(s);
export const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
export const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
export const BOOTSTRAP_URL = "https://api.anthropic.com/api/claude_cli/bootstrap";
export const CLAUDE_CODE_BOOTSTRAP_MODEL = "claude-opus-4-8";
export const CLAUDE_CODE_BOOTSTRAP_USER_AGENT = `claude-code/${claudeCodeVersion}`;
export const CALLBACK_PORT = 54545;
export const SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

export function formatErrorDetails(error: unknown): string {
	if (error instanceof Error) {
		const details: string[] = [`${error.name}: ${error.message}`];
		const errorWithCode = error as Error & { code?: string; errno?: number | string; cause?: unknown };
		if (errorWithCode.code) details.push(`code=${errorWithCode.code}`);
		if (typeof errorWithCode.errno !== "undefined") details.push(`errno=${String(errorWithCode.errno)}`);
		if (typeof error.cause !== "undefined") {
			details.push(`cause=${formatErrorDetails(error.cause)}`);
		}
		if (error.stack) {
			details.push(`stack=${error.stack}`);
		}
		return details.join("; ");
	}
	return String(error);
}

export async function postJson(
	url: string,
	body: Record<string, string | number>,
	fetchImpl: FetchImpl,
	extraHeaders?: Record<string, string>,
): Promise<string> {
	return await withScopedTimeoutSignal(30_000, async signal => {
		const response = await fetchImpl(url, {
			method: "POST",
			headers: {
				...extraHeaders,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal,
		});

		if (!response.ok) {
			const detail = await AIError.readProviderErrorDetail(response);
			throw new AIError.ProviderHttpError(
				`HTTP request failed. status=${response.status}; url=${url}; body=${detail}`,
				response.status,
			);
		}
		return await response.text();
	});
}

export interface AnthropicTokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	account?: { uuid?: string; email_address?: string };
	organization?: { uuid?: string; name?: string };
}

export interface AnthropicBootstrapResponse {
	oauth_account?: {
		account_uuid?: string;
		account_email?: string;
		organization_uuid?: string;
		organization_name?: string;
	};
}

export interface AnthropicIdentity {
	accountId?: string;
	email?: string;
	orgId?: string;
	orgName?: string;
}

export function nonEmpty(value: string | undefined): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseOAuthTokenResponse(responseBody: string, operation: string): AnthropicTokenResponse {
	try {
		return JSON.parse(responseBody) as AnthropicTokenResponse;
	} catch (error) {
		throw new AIError.OAuthError(
			`Anthropic ${operation} returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
			{ kind: "validation", provider: "anthropic", cause: error },
		);
	}
}

function extractAccountFromTokenResponse(data: AnthropicTokenResponse): AnthropicIdentity {
	return {
		accountId: nonEmpty(data.account?.uuid),
		email: nonEmpty(data.account?.email_address),
		orgId: nonEmpty(data.organization?.uuid),
		orgName: nonEmpty(data.organization?.name),
	};
}

async function fetchBootstrapIdentity(accessToken: string, fetchImpl: FetchImpl): Promise<AnthropicIdentity> {
	const url = `${BOOTSTRAP_URL}?entrypoint=cli&model=${encodeURIComponent(CLAUDE_CODE_BOOTSTRAP_MODEL)}`;
	const responseBody = await withScopedTimeoutSignal(30_000, async signal => {
		const response = await fetchImpl(url, {
			method: "GET",
			headers: {
				Accept: "application/json, text/plain, */*",
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				"User-Agent": CLAUDE_CODE_BOOTSTRAP_USER_AGENT,
				"anthropic-beta": "oauth-2025-04-20",
			},
			signal,
		});
		if (!response.ok) {
			const detail = await AIError.readProviderErrorDetail(response);
			throw new AIError.ProviderHttpError(
				`HTTP request failed. status=${response.status}; url=${url}; body=${detail}`,
				response.status,
			);
		}
		return await response.text();
	});
	let data: AnthropicBootstrapResponse;
	try {
		data = JSON.parse(responseBody) as AnthropicBootstrapResponse;
	} catch (error) {
		throw new AIError.OAuthError(
			`Anthropic bootstrap returned invalid JSON. url=${url}; body=${AIError.boundProviderErrorDetail(responseBody)}; details=${formatErrorDetails(error)}`,
			{ kind: "validation", provider: "anthropic", cause: error },
		);
	}
	return {
		accountId: nonEmpty(data.oauth_account?.account_uuid),
		email: nonEmpty(data.oauth_account?.account_email),
		orgId: nonEmpty(data.oauth_account?.organization_uuid),
		orgName: nonEmpty(data.oauth_account?.organization_name),
	};
}

export async function resolveAccountIdentity(
	data: AnthropicTokenResponse,
	fetchImpl: FetchImpl,
	options?: { includeOrg?: boolean },
): Promise<AnthropicIdentity> {
	const identity = extractAccountFromTokenResponse(data);
	const orgSatisfied = !options?.includeOrg || identity.orgId !== undefined;
	if (identity.accountId && identity.email && orgSatisfied) return identity;
	try {
		const bootstrap = await fetchBootstrapIdentity(data.access_token, fetchImpl);
		return {
			accountId: identity.accountId ?? bootstrap.accountId,
			email: identity.email ?? bootstrap.email,
			orgId: identity.orgId ?? bootstrap.orgId,
			orgName: identity.orgName ?? bootstrap.orgName,
		};
	} catch {
		return identity;
	}
}
