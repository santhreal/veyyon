/**
 * In-memory credential rows and the pure functions over them: equality, the secret a row is
 * matched by, OAuth identity dedupe, bearer fingerprints, and the keys backoff and round-robin
 * state are stored under.
 */

import { createHash } from "node:crypto";
import { resolveCredentialIdentityKey } from "../auth-credential-rows";
import * as AIError from "../error";
import type { UsageCredential } from "../usage";
import type {
	ApiKeyCredential,
	AuthCredential,
	CompletionProbeCredential,
	InvalidateCredentialMatchingOptions,
	OAuthCredential,
} from "./types";

export const OAUTH_BEARER_FINGERPRINT_HISTORY_LIMIT = 8;

/** SHA-256 bearer fingerprint, so superseded OAuth token bytes never enter the identity cache. */
export function fingerprintOAuthBearer(bearer: string): string {
	return createHash("sha256").update(bearer).digest("base64url");
}

export type AuthApiKeyOptions = {
	baseUrl?: string;
	modelId?: string;
	/**
	 * Caller's cancel signal. Threaded into any broker-bound OAuth refresh so
	 * `ESC` / request abort actually kills a hung broker fetch instead of
	 * stranding the caller for `timeoutMs * (maxRetries + 1)`.
	 */
	signal?: AbortSignal;
	/**
	 * Force a re-mint of the session-preferred OAuth credential's access token,
	 * bypassing the not-yet-expired short-circuit. Powers step (b) of the
	 * auth-retry policy ("refresh the SAME account") so a locally-cached token
	 * that a peer/broker rotated out from under us is replaced before retrying.
	 */
	forceRefresh?: boolean;
};
export type OAuthResolutionResult = { apiKey: string; credential: OAuthCredential; credentialId?: number };

/**
 * The row an upsert just wrote, found by the secret it holds.
 *
 * An upsert answers with every row the provider now has, not the one it added, and a login needs the
 * one it added: naming an account is meaningless if it names a sibling. The secret is the only field
 * that is unique per row - two rows can share an email, an account id, an organization, and a
 * creation timestamp, which is exactly the Anthropic two-subscription case.
 */
function storedCredentialSecret(credential: AuthCredential): string {
	return credential.type === "api_key" ? credential.key : credential.access;
}

export function matchStoredCredentialId(
	stored: readonly { id: number; credential: AuthCredential }[],
	written: AuthCredential,
): number | undefined {
	const secret = storedCredentialSecret(written);
	return stored.find(entry => storedCredentialSecret(entry.credential) === secret)?.id;
}

export function isAbortSignalOption(
	value: InvalidateCredentialMatchingOptions | AbortSignal | undefined,
): value is AbortSignal {
	return typeof value === "object" && value !== null && "aborted" in value && "addEventListener" in value;
}

/**
 * What a failover notice says killed a credential: the provider's own sentence, else its status.
 *
 * The notice is written after the row is soft-deleted, so this is the last point at which the reason
 * is still readable.
 */
export function authFailureCause(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	const status = AIError.status(error);
	return status === undefined ? "authentication failed" : `HTTP ${status}`;
}

export function authCredentialEquals(left: AuthCredential, right: AuthCredential): boolean {
	if (left.type !== right.type) return false;
	if (left.type === "api_key") {
		return right.type === "api_key" && left.key === right.key;
	}
	if (right.type !== "oauth") return false;
	return (
		left.access === right.access &&
		left.refresh === right.refresh &&
		left.expires === right.expires &&
		left.accountId === right.accountId &&
		left.email === right.email &&
		left.projectId === right.projectId &&
		left.enterpriseUrl === right.enterpriseUrl
	);
}

export function storedCredentialArraysEqual(left: StoredCredential[], right: StoredCredential[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		const leftEntry = left[index];
		const rightEntry = right[index];
		if (!leftEntry || !rightEntry) return false;
		if (leftEntry.id !== rightEntry.id) return false;
		if (!authCredentialEquals(leftEntry.credential, rightEntry.credential)) return false;
	}
	return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory representation
// ─────────────────────────────────────────────────────────────────────────────

export type StoredCredential = { id: number; credential: AuthCredential };
export type CredentialSelection<T extends AuthCredential> = { credential: T; index: number };
export type OAuthSelection = CredentialSelection<OAuthCredential>;
export type ApiKeySelection = CredentialSelection<ApiKeyCredential>;
export type StoredOAuthSelection = { credentialId: number; credential: OAuthCredential; index: number };

export function resolveOAuthDedupeIdentityKey(provider: string, credential: OAuthCredential): string | null {
	return resolveCredentialIdentityKey(provider, credential);
}

export function dedupeOAuthCredentials(provider: string, credentials: AuthCredential[]): AuthCredential[] {
	const seen = new Set<string>();
	const deduped: AuthCredential[] = [];
	for (let index = credentials.length - 1; index >= 0; index -= 1) {
		const credential = credentials[index];
		if (credential.type !== "oauth") {
			deduped.push(credential);
			continue;
		}
		const identityKey = resolveOAuthDedupeIdentityKey(provider, credential);
		if (!identityKey) {
			deduped.push(credential);
			continue;
		}
		if (seen.has(identityKey)) {
			continue;
		}
		seen.add(identityKey);
		deduped.push(credential);
	}
	return deduped.reverse();
}

/** Composite key for round-robin tracking: "anthropic:oauth" or "openai:api_key" */
export function getProviderTypeKey(provider: string, type: AuthCredential["type"]): string {
	return `${provider}:${type}`;
}

/**
 * FNV-1a hash for deterministic session-to-credential mapping.
 * Ensures the same session always starts with the same credential.
 */
export function getHashedIndex(sessionId: string, total: number): number {
	if (total <= 1) return 0;
	return Bun.hash.xxHash32(sessionId) % total;
}

export function toScopedBackoffKey(providerKey: string, blockScope: string | undefined): string {
	return blockScope ? `${providerKey}\0${blockScope}` : providerKey;
}

export function extractStructuredApiKeyToken(apiKey: string): string | undefined {
	if (!apiKey.startsWith("{")) return undefined;
	try {
		const parsed = JSON.parse(apiKey) as { token?: unknown };
		return typeof parsed.token === "string" ? parsed.token : undefined;
	} catch {
		// This asks whether an API key is a structured envelope carrying a token. Text that only LOOKS like
		// JSON is not one, so undefined means "use the key as-is", exactly as for a plain key.
		return undefined;
	}
}

/**
 * Translate a refreshed {@link UsageCredential} into the public
 * {@link CompletionProbeCredential} shape. Returns `null` when the
 * credential lacks any usable bearer bytes (e.g. an API-key row with an
 * empty key, or an OAuth row that never had an `access` token written).
 */
export function buildCompletionProbeCredential(credential: UsageCredential): CompletionProbeCredential | null {
	if (credential.type === "api_key") {
		return credential.apiKey ? { type: "api_key", apiKey: credential.apiKey } : null;
	}
	if (!credential.accessToken) return null;
	return {
		type: "oauth",
		accessToken: credential.accessToken,
		refreshToken: credential.refreshToken,
		expiresAt: credential.expiresAt,
		accountId: credential.accountId,
		projectId: credential.projectId,
		email: credential.email,
		enterpriseUrl: credential.enterpriseUrl,
		apiEndpoint: credential.apiEndpoint,
	};
}
