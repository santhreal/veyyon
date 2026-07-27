/**
 * Credential ROWS: the shapes stored in sqlite and the pure functions that map between them.
 *
 * WHY THIS IS SEPARATE FROM `auth-storage.ts`. That module owns two different jobs. One is the OAuth
 * machinery: refreshing tokens, talking to provider registries, classifying provider errors. The other
 * is persistence: a row shape, a JSON payload, an identity key, a comparison that decides whether one
 * credential replaces another. Only the first needs a provider registry, and it costs 168 modules.
 * Everything here is pure -- strings, JSON, a decoded JWT payload -- so a module that only has to read
 * or write a credential row can name this and pay for nothing else. `packages/coding-agent`'s storage
 * layer is the caller that motivated it: it wants the sqlite store, and reaching it through
 * `auth-storage.ts` put the OAuth flows on the path of everything that reads a setting.
 *
 * The credential TYPES stay in `auth-storage.ts` and arrive here as `import type`, which is erased, so
 * there is no runtime edge back and nothing circular at load time. They are the package's public
 * credential vocabulary and moving them would change every consumer's import for no gain; what moves is
 * the row logic that belongs beside sqlite.
 *
 * NOTHING HERE TOUCHES A DATABASE. The store in `auth-storage-sqlite.ts` holds the statements and the
 * transactions; these are the functions it calls, which is why they can be tested without one.
 */
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

/**
 * SQLite's busy result code family — base `SQLITE_BUSY` plus the extended
 * variants `SQLITE_BUSY_RECOVERY` (concurrent WAL recovery), `SQLITE_BUSY_SNAPSHOT`,
 * and `SQLITE_BUSY_TIMEOUT`. All warrant the same backoff-and-retry treatment.
 */
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

export function normalizeStoredIdentityKey(identityKey: string | null | undefined): string | null {
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

/**
 * Prefix of every `disabled_cause` written because an OAuth REFRESH failed.
 *
 * One owner for the string, because two code paths must agree on it exactly: the
 * six places that generate the cause, and {@link isRefreshFailureDisableCause},
 * which decides whether a later successful refresh may re-enable the row. Get that
 * wrong in the lenient direction and a deliberate logout or a superseded duplicate
 * gets RESURRECTED by an unrelated refresh.
 */
export const OAUTH_REFRESH_FAILURE_DISABLE_PREFIX = "oauth refresh failed";

/**
 * Whether a row's `disabled_cause` marks it as healable by a successful refresh.
 *
 * `null` means the row is active and needs no healing. A refresh-failure cause is
 * healable: the refresh that just succeeded disproves the failure that disabled it.
 * ANY OTHER cause (a logout, a superseded duplicate, a revoked grant) must stay
 * disabled, because nothing about a successful refresh of a different credential
 * says the user wants that row back.
 */
export function isRefreshFailureDisableCause(cause: string | null | undefined): boolean {
	return cause === null || cause === undefined || cause.startsWith(OAUTH_REFRESH_FAILURE_DISABLE_PREFIX);
}

export function toStoredAuthCredential(row: AuthRow, credential: AuthCredential): StoredAuthCredential {
	return { id: row.id, provider: row.provider, credential, disabledCause: row.disabled_cause };
}

export function resolveProviderCredentialIdentityKey(provider: string, identifiers: string[]): string | null {
	const emailIdentifier = identifiers.find(identifier => identifier.startsWith("email:"));
	if (provider === "anthropic") {
		// One Anthropic account email can hold several organizations (e.g. a
		// Team seat plus a personal Max plan), each with its own org-scoped
		// token and limit pools. Scope identity by org so both subscriptions
		// can be stored side by side. The qualifier rides on whichever base
		// identity is available — the account UUID is IDENTICAL across the
		// orgs of one login account, so an unqualified account/project
		// fallback would still collapse two subscriptions whenever the email
		// could not be recovered. Org-less credentials (rows written before
		// org capture existed) keep their bare key.
		const base =
			emailIdentifier ??
			identifiers.find(identifier => identifier.startsWith("account:")) ??
			identifiers.find(identifier => identifier.startsWith("project:"));
		const orgIdentifier = identifiers.find(identifier => identifier.startsWith("org:"));
		if (base) return orgIdentifier ? `${base}|${orgIdentifier}` : base;
		// No base identity at all: the org alone still distinguishes the row.
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
	// One-way upgrade, applied only when the INCOMING identity key carries the
	// org qualifier (only anthropic keys do, so other providers never reach the
	// checks below). An org-scoped login `org:<o>` claims (and re-keys) any
	// existing row that denotes the same subscription:
	//   - `org:<o>` — org-only row stored when identity recovery failed, claimed
	//     once a later same-org login recovers a base identity;
	//   - `<b>` for any base identity `<b>` (email/account/project) the incoming
	//     credential carries — a pre-org legacy row, mirroring the pre-org
	//     replace behavior;
	//   - `<b>|org:<o>` for any such base — the same subscription keyed by a
	//     different base, e.g. an account-keyed row stored while the email could
	//     not be recovered, claimed once a later login recovers the email;
	//   - any same-org row whose STORED credential shares a base identity with
	//     the incoming one — a stored credential can retain identifiers its key
	//     does not use (an email-keyed row also carries the account UUID), so a
	//     later login that loses the email but keeps the account still updates
	//     its row instead of duplicating the subscription.
	// The reverse stays a non-match: an org-less credential only ever replaces
	// via exact key equality above and must never clobber an org-scoped row.
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

export function extractOAuthCredentialIdentifiers(credential: OAuthCredential): string[] {
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
	return [...identifiers];
}

export function extractOAuthTokenIdentifiers(token: string | undefined): string[] | undefined {
	if (!token) return undefined;
	const payload = decodeJwtPayload(token);
	if (!payload) return undefined;
	const identifiers = new Set<string>();
	const directEmail = normalizeStoredEmail(typeof payload.email === "string" ? payload.email : undefined);
	if (directEmail) identifiers.add(`email:${directEmail}`);
	// Both OpenAI claim namespaces, and the rule that an empty claim is no claim, belong to
	// `@veyyon/catalog/wire/codex`. They were spelled here as bare literals, which is the copy a grep for
	// either constant name never finds.
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
	return identifiers.size > 0 ? [...identifiers] : undefined;
}

/**
 * Staleness tolerance for a cached usage report, in milliseconds.
 *
 * Five minutes, because Anthropic and OpenAI rate-limit their usage endpoints at the IP level: every
 * credential cannot be re-fetched every cycle, so a long cache keeps each one's last known value
 * visible while its peers retry. The figures a user reads (5h / 7d / monthly limits) are fine a few
 * minutes stale.
 *
 * HERE RATHER THAN IN `auth-storage.ts` because both halves of the split read it: the OAuth-side report
 * cache and the sqlite store's persisted reconcile window. Two copies would drift, and the store would
 * then persist a window the cache had already decided was stale.
 */
export const USAGE_REPORT_TTL_MS = 5 * 60_000;

/**
 * Downsample usage history to at most one row per hour per account window: a snapshot landing in the
 * same hour bucket as the series' latest row overwrites it in place. That bound makes further retention
 * pruning unnecessary, at roughly 9k rows per account window per year.
 */
export const USAGE_HISTORY_BUCKET_MS = 60 * 60_000;
