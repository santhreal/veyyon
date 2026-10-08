/**
 * Usage requests: the credential a usage backend receives, and the cache keys a request and a
 * batch of requests are stored under.
 */

import { trimTrailingSlashes } from "@veyyon/utils/url";
import type { OAuthCredentials } from "../registry/oauth/types";
import type { Provider } from "../types";
import type { UsageCredential } from "../usage";
import type { StoredCredential } from "./credentials";
import type { AuthCredential, OAuthCredential } from "./types";
import { REMOTE_REFRESH_SENTINEL } from "./types";

const USAGE_REPORT_CACHE_KEY_VERSION_OVERRIDES: Partial<Record<Provider, number>> = {
	"google-antigravity": 2,
	zai: 2,
	// v2: cache identity gained an `org:` component so two subscriptions on one
	// account email stop sharing a slot. The bump also retires pre-org entries —
	// otherwise an org-less credential could replay another org's cached pool
	// (incl. the 24h last-good fallback) via the old bare email/account key.
	anthropic: 2,
};

export type UsageRequestDescriptor = {
	provider: Provider;
	credential: UsageCredential;
	baseUrl?: string;
};

export function buildUsageCredential(credential: AuthCredential): UsageCredential {
	if (credential.type === "api_key") {
		return {
			type: "api_key",
			apiKey: credential.key,
		};
	}
	return {
		type: "oauth",
		accessToken: credential.access,
		refreshToken: credential.refresh,
		expiresAt: credential.expires,
		accountId: credential.accountId,
		projectId: credential.projectId,
		email: credential.email,
		orgId: credential.orgId,
		orgName: credential.orgName,
		enterpriseUrl: credential.enterpriseUrl,
		apiEndpoint: credential.apiEndpoint,
	};
}

export function buildUsageCacheIdentity(credential: UsageCredential): string {
	const parts: string[] = [credential.type];
	const accountId = credential.accountId?.trim();
	if (accountId) parts.push(`account:${accountId}`);
	const email = credential.email?.trim().toLowerCase();
	if (email) parts.push(`email:${email}`);
	const orgId = credential.orgId?.trim();
	if (orgId) parts.push(`org:${orgId}`);
	const projectId = credential.projectId?.trim();
	if (projectId) parts.push(`project:${projectId}`);
	const enterpriseUrl = credential.enterpriseUrl?.trim().toLowerCase();
	if (enterpriseUrl) parts.push(`enterprise:${enterpriseUrl}`);
	// Only fall back to a secret-derived key when a stable account identifier is
	// unavailable. Including the token hash when accountId/email/orgId are present
	// causes cache misses on every OAuth refresh — usage data is per-account (or
	// per-org for org-only anthropic rows), not per-token.
	const hasStableIdentifier = Boolean(accountId || email || orgId);
	if (!hasStableIdentifier) {
		const secret = credential.apiKey?.trim() || credential.refreshToken?.trim() || credential.accessToken?.trim();
		if (secret) {
			parts.push(`secret:${Bun.hash(secret).toString(16)}`);
		} else {
			parts.push("anonymous");
		}
	}
	return parts.join("|");
}

function normalizeUsageBaseUrl(baseUrl?: string): string {
	return baseUrl ? trimTrailingSlashes(baseUrl.trim()) : "";
}

export function buildUsageReportCacheKey(request: UsageRequestDescriptor): string {
	const baseUrl = normalizeUsageBaseUrl(request.baseUrl) || "default";
	const identity = buildUsageCacheIdentity(request.credential);
	const versionOverride = USAGE_REPORT_CACHE_KEY_VERSION_OVERRIDES[request.provider];
	const providerKey = versionOverride === undefined ? request.provider : `${versionOverride}:${request.provider}`;
	return `report:${providerKey}:${baseUrl}:${identity}`;
}

export function buildUsageReportsCacheKey(requests: ReadonlyArray<UsageRequestDescriptor>): string {
	const snapshot = requests
		.map(request => {
			const versionOverride = USAGE_REPORT_CACHE_KEY_VERSION_OVERRIDES[request.provider];
			const providerKey =
				versionOverride === undefined ? request.provider : `${versionOverride}:${request.provider}`;
			return `${providerKey}:${normalizeUsageBaseUrl(request.baseUrl) || "default"}:${buildUsageCacheIdentity(request.credential)}`;
		})
		.sort()
		.join("\n");
	return `reports:${Bun.hash(snapshot).toString(16)}`;
}

export function buildUsageRequest(
	provider: Provider,
	credential: UsageCredential,
	baseUrl?: string,
): UsageRequestDescriptor {
	return { provider, credential, baseUrl };
}

export function buildUsageRequestForOauth(
	provider: Provider,
	credential: OAuthCredential,
	baseUrl?: string,
): UsageRequestDescriptor {
	return buildUsageRequest(provider, buildUsageCredential(credential), baseUrl);
}

export function buildRefreshableOauthCredential(credential: UsageCredential): OAuthCredential | null {
	if (!credential.accessToken || !credential.refreshToken || credential.expiresAt === undefined) {
		return null;
	}
	return {
		type: "oauth",
		access: credential.accessToken,
		refresh: credential.refreshToken,
		expires: credential.expiresAt,
		accountId: credential.accountId,
		projectId: credential.projectId,
		email: credential.email,
		orgId: credential.orgId,
		orgName: credential.orgName,
		enterpriseUrl: credential.enterpriseUrl,
		apiEndpoint: credential.apiEndpoint,
	};
}

export function mergeRefreshedUsageCredential(
	credential: UsageCredential,
	refreshed: OAuthCredentials,
): UsageCredential {
	return {
		...credential,
		accessToken: refreshed.access,
		refreshToken: refreshed.refresh,
		expiresAt: refreshed.expires,
		accountId: refreshed.accountId ?? credential.accountId,
		projectId: refreshed.projectId ?? credential.projectId,
		email: refreshed.email ?? credential.email,
		enterpriseUrl: refreshed.enterpriseUrl ?? credential.enterpriseUrl,
		apiEndpoint: refreshed.apiEndpoint ?? credential.apiEndpoint,
		orgId: refreshed.orgId ?? credential.orgId,
		orgName: refreshed.orgName ?? credential.orgName,
	};
}

/**
 * Whether `entry` is the stored OAuth row a {@link UsageCredential} came from: by refresh
 * token, else by access token, else by the account/email/project/org identity. Broker-backed
 * rows all carry REMOTE_REFRESH_SENTINEL as their refresh token — it identifies nothing, and
 * comparing it would match the FIRST OAuth row regardless of which account/org is being
 * refreshed.
 */
export function isUsageCredentialRow(previous: UsageCredential): (entry: StoredCredential) => boolean {
	const previousRefresh =
		previous.refreshToken && previous.refreshToken !== REMOTE_REFRESH_SENTINEL ? previous.refreshToken : undefined;
	return entry => {
		if (entry.credential.type !== "oauth") return false;
		if (previousRefresh && entry.credential.refresh === previousRefresh) return true;
		if (previous.accessToken && entry.credential.access === previous.accessToken) return true;
		return (
			entry.credential.accountId === previous.accountId &&
			entry.credential.email === previous.email &&
			entry.credential.projectId === previous.projectId &&
			entry.credential.orgId === previous.orgId
		);
	};
}
