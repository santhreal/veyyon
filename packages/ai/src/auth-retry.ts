import * as logger from "@veyyon/utils/logger";
import type { OAuthAccess } from "./auth-storage";
import { RequestAbortError } from "./error/abort";
import { MissingApiKeyError } from "./error/auth";
import { isAuthRetryableError } from "./error/auth-classify";
import { isUsageLimit } from "./error/flags";

export interface ApiKeyResolveContext {
	lastChance: boolean;
	error: unknown;
	previousKey?: string;
	signal?: AbortSignal;
}

export type ApiKeyResolver = (ctx: ApiKeyResolveContext) => Promise<string | undefined> | string | undefined;

export type ApiKey = string | ApiKeyResolver;

export function isApiKeyResolver(key: ApiKey | undefined): key is ApiKeyResolver {
	return typeof key === "function";
}

function throwIfAuthRetryAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw signal.reason ?? new RequestAbortError("Authentication retry aborted by caller");
	}
}

function warnAuthRetry(message: string, fields: Record<string, unknown>): void {
	try {
		logger.warn(message, fields);
	} catch {}
}

export async function resolveApiKeyOnce(key: ApiKey | undefined, signal?: AbortSignal): Promise<string | undefined> {
	if (key === undefined) return undefined;
	if (isApiKeyResolver(key)) return (await key({ lastChance: false, error: undefined, signal })) || undefined;
	return key;
}

export function seedApiKeyResolver(seed: string | undefined, resolver: ApiKeyResolver): ApiKeyResolver {
	let seedPending = seed !== undefined;
	return ctx => {
		if (seedPending && ctx.error === undefined) {
			seedPending = false;
			return seed;
		}
		return resolver(ctx);
	};
}

export { isAuthRetryableError };

export const AUTH_RETRY_STEPS: readonly boolean[] = [false, true];

export const AUTH_RETRY_MAX_ATTEMPTS = 64;

export async function resolveRetryKey(
	resolver: ApiKeyResolver,
	lastChance: boolean,
	error: unknown,
	signal?: AbortSignal,
	previousKey?: string,
): Promise<string | undefined> {
	if (signal?.aborted) return undefined;
	try {
		const rotateSibling = lastChance || (!lastChance && isUsageLimit(error));
		const resolved = (await resolver({ lastChance: rotateSibling, error, signal, previousKey })) || undefined;
		if (signal?.aborted) return undefined;
		return resolved;
	} catch (resolveError) {
		if (signal?.aborted) return undefined;
		warnAuthRetry("Auth retry could not resolve a replacement key; reporting the original auth failure instead", {
			lastChance,
			originalError: String(error),
			resolveError: String(resolveError),
		});
		return undefined;
	}
}

export interface AuthRetryKeyState {
	attemptedKeys: Set<string>;
	lastKey: string;
	refreshedCurrent: boolean;
	legacyAuthSwitchUsed: boolean;
	attempts: number;
}

export function createAuthRetryKeyState(initialKey: string): AuthRetryKeyState {
	return {
		attemptedKeys: new Set([initialKey]),
		lastKey: initialKey,
		refreshedCurrent: false,
		legacyAuthSwitchUsed: false,
		attempts: 1,
	};
}

function acceptRetryKey(state: AuthRetryKeyState, key: string, refreshedCurrent: boolean): string | undefined {
	if (state.attemptedKeys.has(key) || state.attempts >= AUTH_RETRY_MAX_ATTEMPTS) return undefined;
	state.attemptedKeys.add(key);
	state.attempts += 1;
	state.lastKey = key;
	state.refreshedCurrent = refreshedCurrent;
	return key;
}

export async function resolveNextAuthRetryKey(
	state: AuthRetryKeyState,
	resolver: ApiKeyResolver,
	error: unknown,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (signal?.aborted) return undefined;
	if (state.attempts >= AUTH_RETRY_MAX_ATTEMPTS) return undefined;
	const directRotation = isUsageLimit(error);
	if (!directRotation) {
		if (state.legacyAuthSwitchUsed) return undefined;
		if (!state.refreshedCurrent) {
			const refreshed = await resolveRetryKey(resolver, false, error, signal, state.lastKey);
			state.refreshedCurrent = true;
			if (signal?.aborted) return undefined;
			if (refreshed !== undefined) {
				const accepted = acceptRetryKey(state, refreshed, true);
				if (accepted !== undefined) return accepted;
			}
		}
	}

	if (signal?.aborted) return undefined;
	const rotated = await resolveRetryKey(resolver, true, error, signal, state.lastKey);
	if (signal?.aborted || rotated === undefined) return undefined;
	const accepted = acceptRetryKey(state, rotated, !directRotation);
	if (accepted !== undefined && !directRotation) state.legacyAuthSwitchUsed = true;
	return accepted;
}

function oauthCredentialIdentity(access: OAuthAccess): string {
	return access.credentialId !== undefined ? `credential:${access.credentialId}` : `bearer:${access.accessToken}`;
}

async function runOAuthAttempt<T>(
	access: OAuthAccess,
	attempt: (access: OAuthAccess) => Promise<T>,
	isAuthError: (error: unknown) => boolean,
): Promise<{ ok: true; result: T } | { ok: false; error: unknown }> {
	try {
		return { ok: true, result: await attempt(access) };
	} catch (error) {
		if (!isAuthError(error)) throw error;
		return { ok: false, error };
	}
}

export async function withAuth<T>(
	key: ApiKey | undefined,
	attempt: (key: string) => Promise<T>,
	opts?: { isAuthError?: (error: unknown) => boolean; signal?: AbortSignal; missingKeyMessage?: string },
): Promise<T> {
	const isAuthError = opts?.isAuthError ?? isAuthRetryableError;
	const missingKey = (): Error => new MissingApiKeyError(undefined, opts?.missingKeyMessage);
	const signal = opts?.signal;
	throwIfAuthRetryAborted(signal);

	if (!isApiKeyResolver(key)) {
		if (key === undefined) throw missingKey();
		return attempt(key);
	}

	const resolver = key;
	const initialKey =
		(await resolver({ lastChance: false, error: undefined, signal, previousKey: undefined })) || undefined;
	throwIfAuthRetryAborted(signal);
	if (initialKey === undefined) throw missingKey();

	const state = createAuthRetryKeyState(initialKey);
	let lastError: unknown;
	try {
		return await attempt(initialKey);
	} catch (error) {
		if (!isAuthError(error)) throw error;
		throwIfAuthRetryAborted(signal);
		lastError = error;
	}

	while (true) {
		const nextKey = await resolveNextAuthRetryKey(state, resolver, lastError, signal);
		throwIfAuthRetryAborted(signal);
		if (nextKey === undefined) break;
		try {
			return await attempt(nextKey);
		} catch (error) {
			if (!isAuthError(error)) throw error;
			throwIfAuthRetryAborted(signal);
			lastError = error;
		}
	}

	throw lastError;
}

export interface OAuthAccessSource {
	getOAuthAccess(
		provider: string,
		sessionId?: string,
		options?: { forceRefresh?: boolean; signal?: AbortSignal },
	): Promise<OAuthAccess | undefined>;
	rotateSessionCredential(
		provider: string,
		sessionId: string | undefined,
		options?: { error?: unknown; signal?: AbortSignal; apiKey?: string; credentialId?: number },
	): Promise<boolean>;
}

export interface WithOAuthAccessOptions {
	sessionId?: string;
	signal?: AbortSignal;
	isAuthError?: (error: unknown) => boolean;
	seed?: OAuthAccess;
	missingAccessMessage?: string;
}

export async function withOAuthAccess<T>(
	storage: OAuthAccessSource,
	provider: string,
	attempt: (access: OAuthAccess) => Promise<T>,
	opts?: WithOAuthAccessOptions,
): Promise<T> {
	const isAuthError = opts?.isAuthError ?? isAuthRetryableError;
	const { sessionId, signal } = opts ?? {};
	throwIfAuthRetryAborted(signal);

	let lastAccess = opts?.seed;
	if (!lastAccess) {
		lastAccess = await storage.getOAuthAccess(provider, sessionId, { signal });
		throwIfAuthRetryAborted(signal);
	}
	if (!lastAccess) {
		throw new MissingApiKeyError(
			provider,
			opts?.missingAccessMessage ?? `No OAuth credential available for provider: ${provider}`,
		);
	}

	const attemptedBearers = new Set([lastAccess.accessToken]);
	const attemptedCredentialIdentities = new Set([oauthCredentialIdentity(lastAccess)]);
	let attemptCount = 1;
	let legacyAuthSwitchUsed = false;
	let refreshedCurrent = false;
	let attemptResult = await runOAuthAttempt(lastAccess, attempt, isAuthError);
	if (attemptResult.ok) return attemptResult.result;
	throwIfAuthRetryAborted(signal);

	let lastError = attemptResult.error;
	while (true) {
		let next: OAuthAccess | undefined;
		throwIfAuthRetryAborted(signal);
		if (attemptCount >= AUTH_RETRY_MAX_ATTEMPTS) break;
		const directRotation = isUsageLimit(lastError);
		if (!directRotation) {
			if (legacyAuthSwitchUsed) break;
			if (!refreshedCurrent) {
				refreshedCurrent = true;
				try {
					next = await storage.getOAuthAccess(provider, sessionId, { forceRefresh: true, signal });
				} catch (refreshError) {
					throwIfAuthRetryAborted(signal);
					warnAuthRetry("Auth retry could not force-refresh the current credential; falling through to rotation", {
						provider,
						error: String(refreshError),
					});
				}
				throwIfAuthRetryAborted(signal);
				if (next) {
					const bearer = next.accessToken;
					if (!attemptedBearers.has(bearer) && attemptCount < AUTH_RETRY_MAX_ATTEMPTS) {
						attemptedCredentialIdentities.add(oauthCredentialIdentity(next));
						attemptedBearers.add(bearer);
						attemptCount += 1;
						lastAccess = next;
						attemptResult = await runOAuthAttempt(next, attempt, isAuthError);
						if (attemptResult.ok) return attemptResult.result;
						throwIfAuthRetryAborted(signal);
						lastError = attemptResult.error;
						continue;
					}
				}
			}
		}

		throwIfAuthRetryAborted(signal);
		if (attemptCount >= AUTH_RETRY_MAX_ATTEMPTS) break;
		try {
			const rotated = await storage.rotateSessionCredential(provider, sessionId, {
				error: lastError,
				signal,
				apiKey: lastAccess.accessToken,
				credentialId: lastAccess.credentialId,
			});
			throwIfAuthRetryAborted(signal);
			if (!rotated) break;
			next = await storage.getOAuthAccess(provider, sessionId, { signal });
		} catch (rotateError) {
			throwIfAuthRetryAborted(signal);
			warnAuthRetry("Auth retry could not rotate to another credential; giving up and reporting the auth failure", {
				provider,
				error: String(rotateError),
			});
		}
		throwIfAuthRetryAborted(signal);
		if (!next) break;
		const credentialIdentity = oauthCredentialIdentity(next);
		if (
			attemptedCredentialIdentities.has(credentialIdentity) ||
			attemptedBearers.has(next.accessToken) ||
			attemptCount >= AUTH_RETRY_MAX_ATTEMPTS
		) {
			break;
		}
		attemptedCredentialIdentities.add(credentialIdentity);
		attemptedBearers.add(next.accessToken);
		attemptCount += 1;
		lastAccess = next;
		refreshedCurrent = !directRotation;
		if (!directRotation) legacyAuthSwitchUsed = true;
		attemptResult = await runOAuthAttempt(next, attempt, isAuthError);
		if (attemptResult.ok) return attemptResult.result;
		throwIfAuthRetryAborted(signal);
		lastError = attemptResult.error;
	}

	throwIfAuthRetryAborted(signal);
	throw lastError;
}
