import { readCodexClaimsFromPayload } from "@veyyon/catalog/wire/codex";
import { tryParseJson } from "@veyyon/utils/json";
import { decodeJwtPayload } from "@veyyon/utils/jwt";
import { isRecord } from "@veyyon/utils/type-guards";
import type { AuthCredential, OAuthCredential, StoredAuthCredential } from "./auth-storage";
export type AuthRow = {
	id: number;
	provider: string;
	credential_type: string;
	data: string;
	disabled_cause: string | null;
	identity_key: string | null;
};

export type CredentialBlockRow = {
	credential_id: number;
	provider_key: string;
	block_scope: string;
	blocked_until_ms: number;
	updated_at: number;
};

export type SerializedCredentialRecord = {
	credentialType: AuthCredential["type"];
	data: string;
	identityKey: string | null;
};

export const AUTH_SCHEMA_VERSION = 6;

export function isSqliteBusyError(err: unknown): boolean {
	if (err === null || typeof err !== "object") return false;
	const code = (err as { code?: unknown }).code;
	return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

export function normalizeStoredAccountId(accountId: string | null | undefined): string | null {
	const normalized = accountId?.trim();
	return normalized && normalized.length > 0 ? normalized : null;
}

export function normalizeStoredEmail(email: string | null | undefined): string | null {
	const normalized = email?.trim().toLowerCase();
	return normalized && normalized.length > 0 ? normalized : null;
}

function normalizeStoredIdentityKey(identityKey: string | null | undefined): string | null {
	const normalized = identityKey?.trim();
	return normalized && normalized.length > 0 ? normalized : null;
}

export function serializeCredential(provider: string, credential: AuthCredential): SerializedCredentialRecord | null {
	if (credential.type === "api_key") {
		const data = credential.source === "login" ? { key: credential.key, source: "login" } : { key: credential.key };
		return {
			credentialType: "api_key",
			data: JSON.stringify(data),
			identityKey: null,
		};
	}
	if (credential.type === "oauth") {
		const { type: _type, ...rest } = credential;
		return {
			credentialType: "oauth",
			data: JSON.stringify(rest),
			identityKey: resolveCredentialIdentityKey(provider, credential),
		};
	}
	return null;
}

export function deserializeCredential(row: AuthRow): AuthCredential | null {
	const parsed = tryParseJson(row.data);
	if (!isRecord(parsed)) {
		return null;
	}
	if (row.credential_type === "api_key") {
		const data = parsed as Record<string, unknown>;
		if (typeof data.key === "string") {
			const source = data.source === "login" ? "login" : undefined;
			return source ? { type: "api_key", key: data.key, source } : { type: "api_key", key: data.key };
		}
	}
	if (row.credential_type === "oauth") {
		return { type: "oauth", ...(parsed as Record<string, unknown>) } as AuthCredential;
	}
	return null;
}

export function normalizeDisabledCause(disabledCause: string): string {
	const normalized = disabledCause.trim();
	return normalized.length > 0 ? normalized : "disabled";
}

export const OAUTH_REFRESH_FAILURE_DISABLE_PREFIX = "oauth refresh failed";

export function isRefreshFailureDisableCause(cause: string | null | undefined): boolean {
	return cause === null || cause === undefined || cause.startsWith(OAUTH_REFRESH_FAILURE_DISABLE_PREFIX);
}

export function toStoredAuthCredential(row: AuthRow, credential: AuthCredential): StoredAuthCredential {
	return { id: row.id, provider: row.provider, credential, disabledCause: row.disabled_cause };
}

function resolveProviderCredentialIdentityKey(provider: string, identifiers: string[]): string | null {
	const emailIdentifier = identifiers.find(identifier => identifier.startsWith("email:"));
	if (provider === "anthropic") {
		const base =
			emailIdentifier ??
			identifiers.find(identifier => identifier.startsWith("account:")) ??
			identifiers.find(identifier => identifier.startsWith("project:"));
		const orgIdentifier = identifiers.find(identifier => identifier.startsWith("org:"));
		if (base) return orgIdentifier ? `${base}|${orgIdentifier}` : base;
		return orgIdentifier ?? null;
	}
	if (provider === "openai-codex" && emailIdentifier) return emailIdentifier;
	const accountIdentifier = identifiers.find(identifier => identifier.startsWith("account:"));
	if (accountIdentifier) return accountIdentifier;
	if (emailIdentifier) return emailIdentifier;
	const projectIdentifier = identifiers.find(identifier => identifier.startsWith("project:"));
	if (projectIdentifier) return projectIdentifier;
	return null;
}

export function resolveCredentialIdentityKey(provider: string, credential: AuthCredential): string | null {
	if (credential.type === "api_key") return null;
	return resolveProviderCredentialIdentityKey(provider, extractOAuthCredentialIdentifiers(credential));
}

export function resolveRowCredentialIdentityKey(provider: string, row: AuthRow): string | null {
	const identityKey = normalizeStoredIdentityKey(row.identity_key);
	if (identityKey) return identityKey;
	const credential = deserializeCredential(row);
	return credential?.type === "oauth" ? resolveCredentialIdentityKey(provider, credential) : null;
}

export function resolveAccountNameIdentity(provider: string, row: { id: number; credential: AuthCredential }): string {
	const identityKey = row.credential.type === "oauth" ? resolveCredentialIdentityKey(provider, row.credential) : null;
	return `${provider}|${identityKey ?? `id:${row.id}`}`;
}

export function matchesReplacementCredential(
	provider: string,
	existing: AuthCredential | null,
	existingIdentityKey: string | null,
	incoming: AuthCredential,
): boolean {
	if (!existing || existing.type !== incoming.type) return false;
	if (incoming.type === "api_key") {
		return existing.type === "api_key" && existing.key === incoming.key;
	}
	const incomingIdentifiers = extractOAuthCredentialIdentifiers(incoming);
	const incomingIdentityKey = resolveProviderCredentialIdentityKey(provider, incomingIdentifiers);
	if (incomingIdentityKey === null) return false;
	if (incomingIdentityKey === existingIdentityKey) return true;
	if (existingIdentityKey === null) return false;
	const orgIdentifier = incomingIdentifiers.find(identifier => identifier.startsWith("org:"));
	if (orgIdentifier === undefined) return false;
	if (incomingIdentityKey !== orgIdentifier && !incomingIdentityKey.endsWith(`|${orgIdentifier}`)) return false;
	if (existingIdentityKey === orgIdentifier) return true;
	const existingIdentifiers =
		existing.type === "oauth" && existingIdentityKey.endsWith(`|${orgIdentifier}`)
			? extractOAuthCredentialIdentifiers(existing)
			: null;
	for (const identifier of incomingIdentifiers) {
		const isBase =
			identifier.startsWith("email:") || identifier.startsWith("account:") || identifier.startsWith("project:");
		if (!isBase) continue;
		if (existingIdentityKey === identifier) return true;
		if (existingIdentityKey === `${identifier}|${orgIdentifier}`) return true;
		if (existingIdentifiers?.includes(identifier)) return true;
	}
	return false;
}

function extractOAuthCredentialIdentifiers(credential: OAuthCredential): string[] {
	const identifiers = new Set<string>();
	const accountId = normalizeStoredAccountId(credential.accountId);
	if (accountId) identifiers.add(`account:${accountId}`);
	const email = normalizeStoredEmail(credential.email);
	if (email) identifiers.add(`email:${email}`);
	const projectId = normalizeStoredAccountId(credential.projectId);
	if (projectId) identifiers.add(`project:${projectId}`);
	const orgId = normalizeStoredAccountId(credential.orgId);
	if (orgId) identifiers.add(`org:${orgId}`);
	const accessIdentifiers = extractOAuthTokenIdentifiers(credential.access) ?? [];
	for (const identifier of accessIdentifiers) {
		identifiers.add(identifier);
	}
	const refreshIdentifiers = extractOAuthTokenIdentifiers(credential.refresh) ?? [];
	for (const identifier of refreshIdentifiers) {
		identifiers.add(identifier);
	}
	return Array.from(identifiers);
}

function extractOAuthTokenIdentifiers(token: string | undefined): string[] | undefined {
	if (!token) return undefined;
	const payload = decodeJwtPayload(token);
	if (!payload) return undefined;
	const identifiers = new Set<string>();
	const directEmail = normalizeStoredEmail(typeof payload.email === "string" ? payload.email : undefined);
	if (directEmail) identifiers.add(`email:${directEmail}`);
	const codexClaims = readCodexClaimsFromPayload(payload);
	if (codexClaims.email) identifiers.add(`email:${normalizeStoredEmail(codexClaims.email)}`);
	const accountId = normalizeStoredAccountId(
		typeof payload.account_id === "string"
			? payload.account_id
			: typeof payload.accountId === "string"
				? payload.accountId
				: typeof payload.user_id === "string"
					? payload.user_id
					: typeof payload.sub === "string"
						? payload.sub
						: codexClaims.accountId,
	);
	if (accountId) identifiers.add(`account:${accountId}`);
	return identifiers.size > 0 ? Array.from(identifiers) : undefined;
}

export const USAGE_REPORT_TTL_MS = 5 * 60_000;

export const USAGE_HISTORY_BUCKET_MS = 60 * 60_000;
