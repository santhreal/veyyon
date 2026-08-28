import * as logger from "@veyyon/utils/logger";
import { clamp, clamp01 } from "@veyyon/utils/math";
import { scopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";
import { errorMessage } from "@veyyon/utils/type-guards";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import {
	isRefreshFailureDisableCause,
	normalizeStoredAccountId,
	normalizeStoredEmail,
	resolveAccountNameIdentity,
	resolveCredentialIdentityKey,
	serializeCredential,
	USAGE_REPORT_TTL_MS,
} from "./auth-credential-rows";
import type { ApiKeyResolver } from "./auth-retry";
import {
	type ApiKeyCandidate,
	type ApiKeyCredential,
	type ApiKeySelection,
	type AuthApiKeyOptions,
	type AuthCredential,
	type AuthCredentialEntry,
	type AuthCredentialSnapshot,
	type AuthCredentialSnapshotEntry,
	type AuthCredentialStore,
	type AuthStorageData,
	type AuthStorageOptions,
	AuthStorageUsageCache,
	authCredentialEquals,
	authFailureCause,
	type CheckCredentialsOptions,
	type CompletionProbeCredential,
	type CredentialDisabledEvent,
	type CredentialFailoverEvent,
	type CredentialHealthResult,
	type CredentialOrigin,
	compareUsageRankingMetric,
	DEFAULT_OAUTH_REFRESH_TIMEOUT_MS,
	DEFAULT_USAGE_REQUEST_TIMEOUT_MS,
	defaultConfigValueResolver,
	FAILOVER_NOTICE_WINDOW_MS,
	fingerprintOAuthBearer,
	getOpenAICodexPlanEligibility,
	getOpenAICodexPlanPriority,
	type InMemoryCredentialBlock,
	type InvalidateCredentialMatchingOptions,
	isAbortSignalOption,
	MAX_PENDING_DISABLED_EVENTS,
	MAX_WITHHELD_QUOTA_NOTICES,
	matchStoredCredentialId,
	OAUTH_BEARER_FINGERPRINT_HISTORY_LIMIT,
	OAUTH_REFRESH_LEASE_POLL_MS,
	OAUTH_REFRESH_LEASE_RENEW_MS,
	OAUTH_REFRESH_LEASE_TTL_MS,
	OAUTH_REFRESH_OPERATION_TIMEOUT_MS,
	OAUTH_REFRESH_SKEW_MS,
	type OAuthAccess,
	type OAuthAccessResolution,
	type OAuthAccountIdentity,
	type OAuthAccountSummary,
	type OAuthCandidate,
	type OAuthCredential,
	type OAuthLoginIdentity,
	type OAuthResolutionResult,
	type OAuthSelection,
	type OpenAICodexPlanRequirement,
	PRIMARY_WINDOW_HOT_FRACTION,
	type RankedApiKeyCandidate,
	type RankedOAuthCandidate,
	REMOTE_REFRESH_SENTINEL,
	type ResetCreditAccountStatus,
	type ResetCreditRedeemOutcome,
	type ResetCreditTarget,
	raceCredentialRefreshWithSignal,
	raceUsageWithSignal,
	resolveDefaultRankingStrategy,
	resolveDefaultUsageProvider,
	resolveOpenAICodexPlanRequirement,
	SESSION_PIN_CACHE_PREFIX,
	SESSION_PIN_TTL_SECONDS,
	SESSION_STICKY_CACHE_PREFIX,
	type SessionCredentialRouting,
	type SnapshotCredential,
	type StoredAuthCredential,
	type StoredCredential,
	type StoredCredentialBlock,
	type StoredOAuthRefreshOptions,
	type StoredOAuthRefreshResult,
	type StoredOAuthSelection,
	storedCredentialArraysEqual,
	USAGE_FAILURE_BACKOFF_MS,
	USAGE_HEADER_INGEST_INTERVAL_MS,
	USAGE_REPORT_CACHE_KEY_VERSION_OVERRIDES,
	type UsageCache,
	type UsageCandidate,
	type UsageLimitMarkResult,
	type UsageLimitWithheldEvent,
	type UsageRankedCandidate,
	type UsageRankingResult,
	type UsageRequestDescriptor,
	withAuthHttpConcurrency,
} from "./auth-storage-helpers";
import { SqliteAuthCredentialStore } from "./auth-storage-sqlite";
import { isRecordFromFutureClock } from "./credential-clock";
import { getEnvApiKey, getEnvApiKeyName } from "./env-api-key";
import * as AIError from "./error";
import { getProviderDefinition, PASTE_CODE_LOGIN_PROVIDERS } from "./registry";
import { getOAuthApiKey, getOAuthProvider, refreshOAuthToken } from "./registry/oauth";
import type {
	OAuthAuthInfo,
	OAuthController,
	OAuthCredentials,
	OAuthPrompt,
	OAuthProvider,
	OAuthProviderId,
} from "./registry/oauth/types";
import type { Provider } from "./types";
import type {
	CredentialRankingContext,
	CredentialRankingStrategy,
	UsageCostHistoryEntry,
	UsageCredential,
	UsageFetchContext,
	UsageFetchParams,
	UsageHistoryEntry,
	UsageHistoryQuery,
	UsageLimit,
	UsageLogger,
	UsageProvider,
	UsageReport,
} from "./usage";
import { resolveUsedFraction } from "./usage";
import { consumeCodexResetCredit, listCodexResetCredits } from "./usage/openai-codex-reset";
import { listRegisteredUsageProviders } from "./usage/registry";

export {
	type ApiKeyCredential,
	AUTH_HTTP_CONCURRENCY_LIMIT,
	type AuthCredential,
	type AuthCredentialEntry,
	type AuthCredentialSnapshot,
	type AuthCredentialSnapshotEntry,
	type AuthCredentialStore,
	type AuthStorageData,
	type AuthStorageOptions,
	type CheckCredentialsOptions,
	type CompletionProbe,
	type CompletionProbeCredential,
	type CompletionProbeInput,
	type CredentialCompletionResult,
	type CredentialDisabledEvent,
	type CredentialFailoverEvent,
	type CredentialHealthResult,
	type CredentialOrigin,
	type CredentialOriginKind,
	type CredentialRefreshLeaseFence,
	type InvalidateCredentialMatchingOptions,
	type OAuthAccess,
	type OAuthAccessFailure,
	type OAuthAccessResolution,
	type OAuthAccountIdentity,
	type OAuthAccountSummary,
	type OAuthCredential,
	type OAuthLoginIdentity,
	REMOTE_REFRESH_SENTINEL,
	type RemoteOAuthCredential,
	type RemoteRefreshSentinel,
	type ResetCreditAccountStatus,
	type ResetCreditRedeemOutcome,
	type ResetCreditTarget,
	type SerializedAuthStorage,
	type SessionCredentialRouting,
	type SnapshotCredential,
	type StoredAuthCredential,
	type StoredCredentialBlock,
	type StoredOAuthRefreshOptions,
	type StoredOAuthRefreshResult,
	type UsageLimitMarkResult,
	type UsageLimitWithheldEvent,
	withAuthHttpConcurrency,
} from "./auth-storage-helpers";

export class AuthStorage {
	static readonly #defaultBackoffMs = 60_000; // Default backoff when no reset time available

	#data: Map<string, StoredCredential[]> = new Map();
	#runtimeOverrides: Map<string, string> = new Map();
	#configOverrides: Map<string, string> = new Map();
	#providerRoundRobinIndex: Map<string, number> = new Map();
	#reportedStickyCacheFailures = new Set<string>();
	#sessionLastCredential: Map<string, Map<string, { type: AuthCredential["type"]; index: number }>> = new Map();
	#sessionPinnedCredential: Map<string, Map<string, number>> = new Map();
	#providerSelection: Map<string, string | null> = new Map();
	#oauthBearerFingerprints: Map<string, Map<number, string[]>> = new Map();
	#credentialBackoff: Map<string, Map<number, InMemoryCredentialBlock>> = new Map();
	#credentialBackoffProbeAfter: Map<string, Map<number, number>> = new Map();
	#usageProviderResolver?: (provider: Provider) => UsageProvider | undefined;
	#rankingStrategyResolver?: (provider: Provider) => CredentialRankingStrategy | undefined;
	#usageCache: UsageCache;
	#usageCacheEpoch = 0;
	#usageRequestInFlight: Map<string, Promise<UsageReport | null>> = new Map();
	#usageHeaderIngestAt: Map<string, number> = new Map();
	#usageReportsInFlight: Map<string, Promise<UsageReport[] | null>> = new Map();
	#usageFetch: typeof fetch;
	#usageRequestTimeoutMs: number;
	#usageLogger?: UsageLogger;
	#fallbackResolver?: (provider: string) => string | undefined;
	#store: AuthCredentialStore;
	#configValueResolver: (config: string) => Promise<string | undefined>;
	#refreshOAuthCredentialOverride?: AuthStorageOptions["refreshOAuthCredential"];
	#fetchUsageReportsOverride?: AuthStorageOptions["fetchUsageReports"];
	#sourceLabel?: string;
	#credentialDisabledListeners: Set<(event: CredentialDisabledEvent) => void | Promise<void>> = new Set();
	#pendingDisabledEvents: CredentialDisabledEvent[] = [];
	#credentialFailoverListeners: Set<(event: CredentialFailoverEvent) => void | Promise<void>> = new Set();
	#pendingFailover: Map<string, { from: { credentialId: number; label: string }; cause: string; at: number }> =
		new Map();
	#usageLimitWithheldListeners: Set<(event: UsageLimitWithheldEvent) => void | Promise<void>> = new Set();
	#withheldQuotaNotices: Set<string> = new Set();
	#loadBalancing: boolean | (() => boolean) = false;
	#authDeadCredentials: Set<number> = new Set();
	#generation = 1;
	#generationListeners: Set<(generation: number) => void> = new Set();
	#oauthRefreshInFlight: Map<number, Promise<AuthCredentialSnapshotEntry>> = new Map();
	#oauthCredentialRefreshInFlight: Map<number, Promise<OAuthCredentials>> = new Map();
	#closed = false;

	constructor(store: AuthCredentialStore, options: AuthStorageOptions = {}) {
		this.#store = store;
		this.#configValueResolver = options.configValueResolver ?? defaultConfigValueResolver;
		this.#usageProviderResolver = options.usageProviderResolver ?? resolveDefaultUsageProvider;
		this.#rankingStrategyResolver = options.rankingStrategyResolver ?? resolveDefaultRankingStrategy;
		if (options.loadBalancing !== undefined) this.#loadBalancing = options.loadBalancing;
		if (options.onCredentialFailover) {
			this.onCredentialFailover(options.onCredentialFailover);
		}
		if (options.onUsageLimitWithheld) {
			this.onUsageLimitWithheld(options.onUsageLimitWithheld);
		}
		this.#usageCache = new AuthStorageUsageCache(this.#store);
		try {
			this.#store.cleanExpiredCache();
		} catch {}
		try {
			this.#store.cleanExpiredCredentialBlocks?.(Date.now());
		} catch {}
		this.#usageFetch = options.usageFetch ?? fetch;
		this.#usageRequestTimeoutMs = options.usageRequestTimeoutMs ?? DEFAULT_USAGE_REQUEST_TIMEOUT_MS;
		this.#refreshOAuthCredentialOverride = options.refreshOAuthCredential;
		this.#fetchUsageReportsOverride = options.fetchUsageReports;
		this.#sourceLabel = options.sourceLabel;
		if (options.onCredentialDisabled) {
			this.onCredentialDisabled(options.onCredentialDisabled);
		}
		this.#usageLogger =
			options.usageLogger ??
			({
				debug: (message, meta) => logger.debug(message, meta),
				warn: (message, meta) => logger.warn(message, meta),
			} satisfies UsageLogger);
	}

	static async create(dbPath: string, options: AuthStorageOptions = {}): Promise<AuthStorage> {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		return new AuthStorage(store, options);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#store.close();
	}

	getGeneration(): number {
		return this.#generation;
	}

	onGenerationChanged(listener: (generation: number) => void): () => void {
		this.#generationListeners.add(listener);
		return () => {
			this.#generationListeners.delete(listener);
		};
	}

	offGenerationChanged(listener: (generation: number) => void): void {
		this.#generationListeners.delete(listener);
	}

	#bumpGeneration(reason: string): void {
		this.#generation += 1;
		for (const listener of Array.from(this.#generationListeners)) {
			try {
				listener(this.#generation);
			} catch (error) {
				logger.debug("AuthStorage generation listener failed", { reason, error: String(error) });
			}
		}
	}

	onCredentialDisabled(listener: (event: CredentialDisabledEvent) => void | Promise<void>): () => void {
		const wasEmpty = this.#credentialDisabledListeners.size === 0;
		this.#credentialDisabledListeners.add(listener);
		if (wasEmpty && this.#pendingDisabledEvents.length > 0) {
			const drained = this.#pendingDisabledEvents;
			this.#pendingDisabledEvents = [];
			for (const event of drained) {
				this.#invokeListener(listener, event);
			}
		}
		return () => {
			this.#credentialDisabledListeners.delete(listener);
		};
	}

	onCredentialFailover(listener: (event: CredentialFailoverEvent) => void | Promise<void>): () => void {
		this.#credentialFailoverListeners.add(listener);
		return () => {
			this.#credentialFailoverListeners.delete(listener);
		};
	}

	#emitCredentialFailover(event: CredentialFailoverEvent): void {
		for (const listener of Array.from(this.#credentialFailoverListeners)) {
			const logListenerError = (error: unknown): void => {
				logger.warn("onCredentialFailover listener threw", { provider: event.provider, error: String(error) });
			};
			try {
				const result = listener(event);
				if (result instanceof Promise) result.catch(logListenerError);
			} catch (error) {
				logListenerError(error);
			}
		}
	}

	onUsageLimitWithheld(listener: (event: UsageLimitWithheldEvent) => void | Promise<void>): () => void {
		this.#usageLimitWithheldListeners.add(listener);
		return () => {
			this.#usageLimitWithheldListeners.delete(listener);
		};
	}

	#emitUsageLimitWithheld(event: UsageLimitWithheldEvent): void {
		for (const listener of Array.from(this.#usageLimitWithheldListeners)) {
			const logListenerError = (error: unknown): void => {
				logger.warn("onUsageLimitWithheld listener threw", { provider: event.provider, error: String(error) });
			};
			try {
				const result = listener(event);
				if (result instanceof Promise) result.catch(logListenerError);
			} catch (error) {
				logListenerError(error);
			}
		}
	}

	#accountNoticeLabel(provider: string, credentialId: number): string {
		const named = this.getAccountName(provider, credentialId);
		if (named) return named;
		const row = this.#getStoredCredentials(provider).find(entry => entry.id === credentialId);
		if (!row) return `#${credentialId}`;
		if (row.credential.type === "oauth") {
			const email = normalizeStoredEmail(row.credential.email);
			if (email) return email;
			const accountId = normalizeStoredAccountId(row.credential.accountId);
			if (accountId) return accountId;
		}
		return `#${credentialId}`;
	}

	#loadBalancingEnabled(): boolean {
		const setting = this.#loadBalancing;
		return typeof setting === "function" ? setting() : setting;
	}

	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.#runtimeOverrides.set(provider, apiKey);
	}

	removeRuntimeApiKey(provider: string): void {
		this.#runtimeOverrides.delete(provider);
	}

	setConfigApiKey(provider: string, apiKey: string): void {
		this.#configOverrides.set(provider, apiKey);
	}

	removeConfigApiKey(provider: string): void {
		this.#configOverrides.delete(provider);
	}

	clearConfigApiKeys(): void {
		this.#configOverrides.clear();
	}

	setFallbackResolver(resolver: (provider: string) => string | undefined): void {
		this.#fallbackResolver = resolver;
	}

	async reload(): Promise<void> {
		const records = this.#store.listAuthCredentials();
		const grouped = new Map<string, StoredCredential[]>();
		for (const record of records) {
			const list = grouped.get(record.provider) ?? [];
			list.push({ id: record.id, credential: record.credential });
			grouped.set(record.provider, list);
		}

		const dedupedGrouped = new Map<string, StoredCredential[]>();
		for (const [provider, entries] of grouped.entries()) {
			const deduped = this.#pruneDuplicateStoredCredentials(provider, entries);
			if (deduped.length > 0) {
				dedupedGrouped.set(provider, deduped);
			}
		}

		const removedProviders = new Set(this.#data.keys());
		for (const [provider, entries] of dedupedGrouped) {
			this.#setStoredCredentials(provider, entries);
			removedProviders.delete(provider);
		}
		for (const provider of removedProviders) {
			this.#setStoredCredentials(provider, []);
		}
	}

	#getStoredCredentials(provider: string): StoredCredential[] {
		return this.#data.get(provider) ?? [];
	}

	#setStoredCredentials(provider: string, credentials: StoredCredential[]): void {
		const current = this.#data.get(provider) ?? [];
		if (storedCredentialArraysEqual(current, credentials)) return;
		const trackedBearerFingerprints = this.#oauthBearerFingerprints.get(provider);
		if (trackedBearerFingerprints) {
			const activeOAuthIds = new Set(
				credentials.filter(entry => entry.credential.type === "oauth").map(entry => entry.id),
			);
			for (const credentialId of trackedBearerFingerprints.keys()) {
				if (!activeOAuthIds.has(credentialId)) trackedBearerFingerprints.delete(credentialId);
			}
			if (trackedBearerFingerprints.size === 0) this.#oauthBearerFingerprints.delete(provider);
		}
		if (credentials.length === 0) {
			this.#data.delete(provider);
		} else {
			this.#data.set(provider, credentials);
		}
		this.#bumpGeneration("credentials");
	}

	#recordOAuthBearerCredentialId(provider: string, bearer: string, credentialId: number | undefined): void {
		if (credentialId === undefined) return;
		const fingerprint = fingerprintOAuthBearer(bearer);
		const byCredentialId = this.#oauthBearerFingerprints.get(provider) ?? new Map<number, string[]>();
		const history = byCredentialId.get(credentialId) ?? [];
		const nextHistory = history.filter(previous => previous !== fingerprint);
		nextHistory.push(fingerprint);
		if (nextHistory.length > OAUTH_BEARER_FINGERPRINT_HISTORY_LIMIT) nextHistory.shift();
		byCredentialId.set(credentialId, nextHistory);
		this.#oauthBearerFingerprints.set(provider, byCredentialId);
	}

	#findOAuthCredentialIdForBearer(provider: string, bearer: string): number | undefined {
		const fingerprint = fingerprintOAuthBearer(bearer);
		for (const [credentialId, history] of this.#oauthBearerFingerprints.get(provider) ?? []) {
			if (history.includes(fingerprint)) return credentialId;
		}
		return undefined;
	}

	#resolveOAuthDedupeIdentityKey(provider: string, credential: OAuthCredential): string | null {
		return resolveCredentialIdentityKey(provider, credential);
	}

	#dedupeOAuthCredentials(provider: string, credentials: AuthCredential[]): AuthCredential[] {
		const seen = new Set<string>();
		const deduped: AuthCredential[] = [];
		for (let index = credentials.length - 1; index >= 0; index -= 1) {
			const credential = credentials[index];
			if (credential.type !== "oauth") {
				deduped.push(credential);
				continue;
			}
			const identityKey = this.#resolveOAuthDedupeIdentityKey(provider, credential);
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

	#pruneDuplicateStoredCredentials(provider: string, entries: StoredCredential[]): StoredCredential[] {
		const seen = new Set<string>();
		const kept: StoredCredential[] = [];
		const removed: StoredCredential[] = [];
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];
			const credential = entry.credential;
			if (credential.type !== "oauth") {
				kept.push(entry);
				continue;
			}
			const identityKey = this.#resolveOAuthDedupeIdentityKey(provider, credential);
			if (!identityKey) {
				kept.push(entry);
				continue;
			}
			if (seen.has(identityKey)) {
				removed.push(entry);
				continue;
			}
			seen.add(identityKey);
			kept.push(entry);
		}
		if (removed.length > 0) {
			for (const entry of removed) {
				this.#store.deleteAuthCredential(entry.id, "deduplicated duplicate credential");
			}
			this.#resetProviderAssignments(provider);
		}
		return kept.reverse();
	}

	#getCredentialsForProvider(provider: string): AuthCredential[] {
		return this.#getStoredCredentials(provider).map(entry => entry.credential);
	}

	#getProviderTypeKey(provider: string, type: AuthCredential["type"]): string {
		return `${provider}:${type}`;
	}

	#getNextRoundRobinIndex(providerKey: string, total: number): number {
		if (total <= 1) return 0;
		const current = this.#providerRoundRobinIndex.get(providerKey) ?? -1;
		const next = (current + 1) % total;
		this.#providerRoundRobinIndex.set(providerKey, next);
		return next;
	}

	#getHashedIndex(sessionId: string, total: number): number {
		if (total <= 1) return 0;
		return Bun.hash.xxHash32(sessionId) % total;
	}

	#getCredentialOrder(providerKey: string, sessionId: string | undefined, total: number): number[] {
		if (total <= 1) return [0];
		const start = sessionId
			? this.#getHashedIndex(sessionId, total)
			: this.#getNextRoundRobinIndex(providerKey, total);
		const order: number[] = [];
		for (let i = 0; i < total; i++) {
			order.push((start + i) % total);
		}
		return order;
	}

	#toScopedBackoffKey(providerKey: string, blockScope: string | undefined): string {
		return blockScope ? `${providerKey}\0${blockScope}` : providerKey;
	}

	#getCredentialBlockedUntilForKey(backoffKey: string, credentialIndex: number, nowMs: number): number | undefined {
		const backoffMap = this.#credentialBackoff.get(backoffKey);
		if (!backoffMap) return undefined;
		const entry = backoffMap.get(credentialIndex);
		if (!entry?.blockedUntilMs) return undefined;
		const { blockedUntilMs: blockedUntil, blockedAtMs } = entry;
		if (blockedUntil <= nowMs || isRecordFromFutureClock(blockedAtMs, nowMs)) {
			backoffMap.delete(credentialIndex);
			if (backoffMap.size === 0) {
				this.#credentialBackoff.delete(backoffKey);
			}
			const probeAfterMap = this.#credentialBackoffProbeAfter.get(backoffKey);
			probeAfterMap?.delete(credentialIndex);
			if (probeAfterMap?.size === 0) this.#credentialBackoffProbeAfter.delete(backoffKey);
			return undefined;
		}
		return blockedUntil;
	}

	#readPersistedCredentialBlock(
		credentialId: number,
		providerKey: string,
		blockScope: string | undefined,
	): number | undefined {
		const getCredentialBlock = this.#store.getCredentialBlock?.bind(this.#store);
		if (!getCredentialBlock) return undefined;
		try {
			return getCredentialBlock(credentialId, providerKey, blockScope ?? "");
		} catch (err) {
			logger.debug("Failed to read credential block from persistent store", {
				err,
				credentialId,
				providerKey,
				blockScope,
			});
			return undefined;
		}
	}

	#getCredentialBlockedUntil(
		provider: string,
		providerKey: string,
		credentialIndex: number,
		blockScope: string | undefined = undefined,
	): number | undefined {
		const nowMs = Date.now();
		let blockedUntil = this.#getCredentialBlockedUntilForKey(providerKey, credentialIndex, nowMs);
		if (blockScope) {
			const scopedBlockedUntil = this.#getCredentialBlockedUntilForKey(
				this.#toScopedBackoffKey(providerKey, blockScope),
				credentialIndex,
				nowMs,
			);
			if (scopedBlockedUntil !== undefined && (blockedUntil === undefined || scopedBlockedUntil > blockedUntil)) {
				blockedUntil = scopedBlockedUntil;
			}
		}

		const credentialId = this.#getStoredCredentials(provider)[credentialIndex]?.id;
		if (credentialId === undefined) return blockedUntil;
		if (!blockScope || provider !== "openai-codex") {
			const persistedGlobalBlockedUntil = this.#readPersistedCredentialBlock(credentialId, providerKey, "");
			if (
				persistedGlobalBlockedUntil !== undefined &&
				(blockedUntil === undefined || persistedGlobalBlockedUntil > blockedUntil)
			) {
				blockedUntil = persistedGlobalBlockedUntil;
			}
		}
		if (blockScope) {
			const persistedScopedBlockedUntil = this.#readPersistedCredentialBlock(credentialId, providerKey, blockScope);
			if (
				persistedScopedBlockedUntil !== undefined &&
				(blockedUntil === undefined || persistedScopedBlockedUntil > blockedUntil)
			) {
				blockedUntil = persistedScopedBlockedUntil;
			}
		}
		return blockedUntil;
	}

	credentialBlockedUntil(
		provider: string,
		providerKey: string,
		credentialIndex: number,
		blockScope?: string,
	): number | undefined {
		return this.#getCredentialBlockedUntil(provider, providerKey, credentialIndex, blockScope);
	}

	#isCredentialBlocked(
		provider: string,
		providerKey: string,
		credentialIndex: number,
		blockScope: string | undefined = undefined,
	): boolean {
		return this.#getCredentialBlockedUntil(provider, providerKey, credentialIndex, blockScope) !== undefined;
	}

	#markCredentialBlocked(
		provider: string,
		providerKey: string,
		credentialIndex: number,
		blockedUntilMs: number,
		blockScope: string | undefined = undefined,
	): void {
		const backoffKey = this.#toScopedBackoffKey(providerKey, blockScope);
		const nowMs = Date.now();
		const backoffMap = this.#credentialBackoff.get(backoffKey) ?? new Map<number, InMemoryCredentialBlock>();
		const existing = backoffMap.get(credentialIndex);
		const carryForward =
			existing && !isRecordFromFutureClock(existing.blockedAtMs, nowMs) ? existing.blockedUntilMs : 0;
		const nextBlockedUntil = Math.max(carryForward, blockedUntilMs);
		backoffMap.set(credentialIndex, { blockedUntilMs: nextBlockedUntil, blockedAtMs: nowMs });
		this.#credentialBackoff.set(backoffKey, backoffMap);
		const probeAfterMap = this.#credentialBackoffProbeAfter.get(backoffKey) ?? new Map<number, number>();
		probeAfterMap.set(credentialIndex, Math.min(nextBlockedUntil, nowMs + USAGE_REPORT_TTL_MS));
		this.#credentialBackoffProbeAfter.set(backoffKey, probeAfterMap);
		this.#invalidateUsageReportCache(provider);

		const upsertCredentialBlock = this.#store.upsertCredentialBlock?.bind(this.#store);
		if (!upsertCredentialBlock) return;
		const credentialId = this.#getStoredCredentials(provider)[credentialIndex]?.id;
		if (credentialId === undefined) return;
		try {
			upsertCredentialBlock({
				credentialId,
				providerKey,
				blockScope: blockScope ?? "",
				blockedUntilMs: nextBlockedUntil,
			});
		} catch (err) {
			logger.debug("Failed to persist credential block", {
				err,
				credentialId,
				provider,
				providerKey,
				blockScope,
				blockedUntilMs: nextBlockedUntil,
			});
		}
	}

	#recordSessionCredential(
		provider: string,
		sessionId: string | undefined,
		type: AuthCredential["type"],
		index: number,
	): void {
		const credentialId = this.#getStoredCredentials(provider)[index]?.id;
		if (credentialId !== undefined) this.#drainPendingFailover(provider, credentialId);
		if (!sessionId) return;
		const sessionMap = this.#sessionLastCredential.get(provider) ?? new Map();
		sessionMap.set(sessionId, { type, index });
		this.#sessionLastCredential.set(provider, sessionMap);

		try {
			if (credentialId !== undefined) {
				const cacheKey = `${SESSION_STICKY_CACHE_PREFIX}${provider}:${sessionId}`;
				const cacheValue = JSON.stringify({ type, index, credentialId });
				const expiresAtSec = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
				this.#store.setCache(cacheKey, cacheValue, expiresAtSec);
			}
		} catch (err) {
			this.#reportStickyCacheFailure("write", provider, err);
		}
	}

	#drainPendingFailover(provider: string, servedCredentialId: number): void {
		const pending = this.#pendingFailover.get(provider);
		if (!pending) return;
		this.#pendingFailover.delete(provider);
		if (pending.from.credentialId === servedCredentialId) return;
		if (Date.now() - pending.at > FAILOVER_NOTICE_WINDOW_MS) return;
		this.#emitCredentialFailover({
			provider,
			from: pending.from,
			to: { credentialId: servedCredentialId, label: this.#accountNoticeLabel(provider, servedCredentialId) },
			cause: pending.cause,
		});
	}

	#reportStickyCacheFailure(operation: string, provider: string, error: unknown): void {
		const key = `${operation}:${provider}`;
		const alreadyReported = this.#reportedStickyCacheFailures.has(key);
		this.#reportedStickyCacheFailures.add(key);
		const detail = {
			provider,
			operation,
			error: String(error),
		};
		if (alreadyReported) {
			logger.debug("Session sticky credential cache still failing", detail);
			return;
		}
		logger.warn(
			"Session sticky credential cache failed; this session is no longer pinned to one credential and may route to a different account",
			detail,
		);
	}

	#getSessionCredentialPin(
		provider: string,
		sessionId: string | undefined,
	): { type: AuthCredential["type"]; index: number; credentialId: number } | undefined {
		if (!sessionId) return this.#getSelectedCredential(provider);
		let credentialId = this.#sessionPinnedCredential.get(provider)?.get(sessionId);
		if (credentialId === undefined) {
			try {
				const raw = this.#store.getCache(`${SESSION_PIN_CACHE_PREFIX}${provider}:${sessionId}`);
				if (!raw) return this.#getSelectedCredential(provider);
				const parsed = JSON.parse(raw) as { credentialId?: number };
				if (typeof parsed.credentialId !== "number") return this.#getSelectedCredential(provider);
				credentialId = parsed.credentialId;
				const pinMap = this.#sessionPinnedCredential.get(provider) ?? new Map<string, number>();
				pinMap.set(sessionId, credentialId);
				this.#sessionPinnedCredential.set(provider, pinMap);
			} catch (err) {
				this.#reportStickyCacheFailure("pin-read", provider, err);
				return this.#getSelectedCredential(provider);
			}
		}
		const stored = this.#getStoredCredentials(provider);
		const index = stored.findIndex(entry => entry.id === credentialId);
		if (index === -1) {
			this.clearSessionCredentialPin(provider, sessionId);
			return this.#getSelectedCredential(provider);
		}
		const credential = stored[index]?.credential;
		if (!credential) return this.#getSelectedCredential(provider);
		return { type: credential.type, index, credentialId };
	}

	#getSessionCredential(
		provider: string,
		sessionId: string | undefined,
	): { type: AuthCredential["type"]; index: number } | undefined {
		const pinned = this.#getSessionCredentialPin(provider, sessionId);
		if (pinned) return { type: pinned.type, index: pinned.index };
		return this.#getStickySessionCredential(provider, sessionId);
	}

	#getStickySessionCredential(
		provider: string,
		sessionId: string | undefined,
	): { type: AuthCredential["type"]; index: number } | undefined {
		if (!sessionId) return undefined;
		let sessionMap = this.#sessionLastCredential.get(provider);
		if (sessionMap?.has(sessionId)) {
			return sessionMap.get(sessionId);
		}
		try {
			const cacheKey = `${SESSION_STICKY_CACHE_PREFIX}${provider}:${sessionId}`;
			const raw = this.#store.getCache(cacheKey);
			if (raw) {
				const val = JSON.parse(raw) as { type: AuthCredential["type"]; index: number; credentialId?: number };

				if (val.credentialId !== undefined) {
					const stored = this.#getStoredCredentials(provider);
					const actualIndex = stored.findIndex(entry => entry.id === val.credentialId);
					if (actualIndex === -1 || stored[actualIndex]?.credential.type !== val.type) {
						this.#store.setCache(cacheKey, "", 0);
						return undefined;
					}
					val.index = actualIndex;
				} else {
					// Fallback: drop unsafe index-only cache rows to prevent wrong-account routing
					this.#store.setCache(cacheKey, "", 0);
					return undefined;
				}

				if (!sessionMap) {
					sessionMap = new Map();
					this.#sessionLastCredential.set(provider, sessionMap);
				}
				const sessionVal = { type: val.type, index: val.index };
				sessionMap.set(sessionId, sessionVal);
				return sessionVal;
			}
		} catch (err) {
			this.#reportStickyCacheFailure("read", provider, err);
		}
		return undefined;
	}

	#clearSessionCredential(provider: string, sessionId: string | undefined): void {
		if (!sessionId) return;
		const sessionMap = this.#sessionLastCredential.get(provider);
		if (sessionMap) {
			sessionMap.delete(sessionId);
			if (sessionMap.size === 0) {
				this.#sessionLastCredential.delete(provider);
			}
		}
		try {
			const cacheKey = `${SESSION_STICKY_CACHE_PREFIX}${provider}:${sessionId}`;
			this.#store.setCache(cacheKey, "", 0);
		} catch (err) {
			this.#reportStickyCacheFailure("clear", provider, err);
		}
	}

	pinSessionCredential(provider: string, sessionId: string | undefined, credentialId: number): boolean {
		if (!sessionId) return false;
		const stored = this.#getStoredCredentials(provider);
		if (!stored.some(entry => entry.id === credentialId)) return false;
		const pinMap = this.#sessionPinnedCredential.get(provider) ?? new Map<string, number>();
		pinMap.set(sessionId, credentialId);
		this.#sessionPinnedCredential.set(provider, pinMap);
		try {
			this.#store.setCache(
				`${SESSION_PIN_CACHE_PREFIX}${provider}:${sessionId}`,
				JSON.stringify({ credentialId }),
				Math.floor(Date.now() / 1000) + SESSION_PIN_TTL_SECONDS,
			);
		} catch (err) {
			this.#reportStickyCacheFailure("pin-write", provider, err);
		}
		this.#clearSessionCredential(provider, sessionId);
		return true;
	}

	clearSessionCredentialPin(provider: string, sessionId: string | undefined): void {
		if (!sessionId) return;
		const pinMap = this.#sessionPinnedCredential.get(provider);
		if (pinMap) {
			pinMap.delete(sessionId);
			if (pinMap.size === 0) this.#sessionPinnedCredential.delete(provider);
		}
		try {
			this.#store.setCache(`${SESSION_PIN_CACHE_PREFIX}${provider}:${sessionId}`, "", 0);
		} catch (err) {
			this.#reportStickyCacheFailure("pin-clear", provider, err);
		}
	}

	#readProviderSelection(provider: string): string | undefined {
		const memo = this.#providerSelection.get(provider);
		if (memo !== undefined) return memo ?? undefined;
		const read = this.#store.getProviderSelection;
		const identity = read ? read.call(this.#store, provider) : undefined;
		this.#providerSelection.set(provider, identity ?? null);
		return identity;
	}

	#getSelectedCredential(
		provider: string,
	): { type: AuthCredential["type"]; index: number; credentialId: number } | undefined {
		const identity = this.#readProviderSelection(provider);
		if (!identity) return undefined;
		const stored = this.#getStoredCredentials(provider);
		const index = stored.findIndex(entry => resolveAccountNameIdentity(provider, entry) === identity);
		const entry = index === -1 ? undefined : stored[index];
		if (!entry) return undefined;
		return { type: entry.credential.type, index, credentialId: entry.id };
	}

	selectedProviderCredentialId(provider: string): number | undefined {
		return this.#getSelectedCredential(provider)?.credentialId;
	}

	#explicitChoiceIndex(
		provider: string,
		sessionId: string | undefined,
		type: AuthCredential["type"],
	): number | undefined {
		const pinned = this.#getSessionCredentialPin(provider, sessionId);
		const chosen = pinned ?? this.#getSelectedCredential(provider);
		if (chosen?.type !== type) return undefined;
		const credentialId = this.#getStoredCredentials(provider)[chosen.index]?.id;
		if (credentialId !== undefined && this.#authDeadCredentials.has(credentialId)) return undefined;
		return chosen.index;
	}

	selectProviderCredential(provider: string, credentialId: number, options?: { sessionId?: string }): boolean {
		const entry = this.#getStoredCredentials(provider).find(row => row.id === credentialId);
		if (!entry) return false;
		const identity = resolveAccountNameIdentity(provider, entry);
		this.#providerSelection.set(provider, identity);
		const write = this.#store.setProviderSelection;
		if (write) {
			try {
				write.call(this.#store, provider, identity);
			} catch (err) {
				this.#reportStickyCacheFailure("selection-write", provider, err);
			}
		}
		this.clearSessionCredentialPin(provider, options?.sessionId);
		this.#clearSessionCredential(provider, options?.sessionId);
		return true;
	}

	clearProviderSelection(provider: string, options?: { sessionId?: string }): void {
		this.#providerSelection.set(provider, null);
		const clear = this.#store.clearProviderSelection;
		if (clear) {
			try {
				clear.call(this.#store, provider);
			} catch (err) {
				this.#reportStickyCacheFailure("selection-clear", provider, err);
			}
		}
		this.#clearSessionCredential(provider, options?.sessionId);
	}

	sessionCredentialRouting(provider: string, sessionId: string | undefined): SessionCredentialRouting | undefined {
		const stored = this.#getStoredCredentials(provider);
		if (stored.length === 0) return undefined;
		const routing: SessionCredentialRouting = { provider };
		const pin = this.#getSessionCredentialPin(provider, sessionId);
		const sticky = this.#getStickySessionCredential(provider, sessionId);
		const stickyEntry = sticky ? stored[sticky.index] : undefined;
		if (pin) {
			routing.selectedCredentialId = pin.credentialId;
			const blockedUntil = this.credentialBlockedUntil(
				provider,
				this.#getProviderTypeKey(provider, stored[pin.index]!.credential.type),
				pin.index,
			);
			if (blockedUntil !== undefined) routing.selectedBlockedUntilMs = blockedUntil;
			const choiceStillLeads =
				this.#explicitChoiceIndex(provider, sessionId, stored[pin.index]!.credential.type) === pin.index;
			if (choiceStillLeads) {
				routing.activeCredentialId = pin.credentialId;
				return routing;
			}
		}
		if (sticky && stickyEntry && this.#credentialUsableNow(provider, stickyEntry, sticky.index)) {
			routing.activeCredentialId = stickyEntry.id;
			return routing;
		}
		const predicted = this.#predictNextCredentialId(provider, sessionId);
		if (predicted !== undefined) {
			routing.activeCredentialId = predicted;
			routing.activeIsPrediction = true;
			return routing;
		}
		if (stickyEntry) routing.activeCredentialId = stickyEntry.id;
		return routing;
	}

	#credentialUsableNow(provider: string, entry: StoredCredential, index: number): boolean {
		const providerKey = this.#getProviderTypeKey(provider, entry.credential.type);
		return this.credentialBlockedUntil(provider, providerKey, index) === undefined;
	}

	#predictNextCredentialId(provider: string, sessionId: string | undefined): number | undefined {
		const stored = this.#getStoredCredentials(provider);
		if (stored.length === 0) return undefined;
		let refused: number | undefined;
		for (const type of ["oauth", "api_key"] as const) {
			const candidates = stored
				.map((entry, index) => ({ entry, index }))
				.filter(candidate => candidate.entry.credential.type === type);
			if (candidates.length === 0) continue;
			const providerKey = this.#getProviderTypeKey(provider, type);
			const start = sessionId
				? this.#getHashedIndex(sessionId, candidates.length)
				: ((((this.#providerRoundRobinIndex.get(providerKey) ?? -1) + 1) % candidates.length) + candidates.length) %
					candidates.length;
			const rotated = candidates.map((_, offset) => candidates[(start + offset) % candidates.length]!);
			const ordered = this.#orderByBlockAvailability(provider, providerKey, rotated);
			const chosen = ordered.find(candidate => !this.#authDeadCredentials.has(candidate.entry.id));
			if (chosen) return chosen.entry.id;
			refused ??= ordered[0]?.entry.id;
		}
		return refused;
	}

	getAccountName(provider: string, credentialId: number): string | undefined {
		const read = this.#store.getAccountName;
		if (!read) return undefined;
		const row = this.#getStoredCredentials(provider).find(entry => entry.id === credentialId);
		if (!row) return undefined;
		return read.call(this.#store, resolveAccountNameIdentity(provider, row));
	}

	setAccountName(provider: string, credentialId: number, name: string): boolean {
		const row = this.#getStoredCredentials(provider).find(entry => entry.id === credentialId);
		if (!row) return false;
		const identity = resolveAccountNameIdentity(provider, row);
		const trimmed = name.trim();
		if (trimmed.length === 0) {
			const remove = this.#store.deleteAccountName;
			if (!remove) return false;
			remove.call(this.#store, identity);
			return true;
		}
		const write = this.#store.setAccountName;
		if (!write) return false;
		write.call(this.#store, identity, trimmed);
		return true;
	}

	#selectCredentialByType<T extends AuthCredential["type"]>(
		provider: string,
		type: T,
		sessionId?: string,
		filter?: (credential: AuthCredential) => boolean,
	): { credential: Extract<AuthCredential, { type: T }>; index: number } | undefined {
		const credentials = this.#getCredentialsForProvider(provider)
			.map((credential, index) => ({ credential, index }))
			.filter((entry): entry is { credential: Extract<AuthCredential, { type: T }>; index: number } => {
				if (entry.credential.type !== type) return false;
				return filter?.(entry.credential) ?? true;
			});

		if (credentials.length === 0) return undefined;
		if (credentials.length === 1) return credentials[0];

		const providerKey = this.#getProviderTypeKey(provider, type);
		const order = this.#getCredentialOrder(providerKey, sessionId, credentials.length);
		const ordered = this.#leadWithChosenAccount(
			this.#orderByBlockAvailability(
				provider,
				providerKey,
				order.map(idx => credentials[idx]),
			),
			this.#explicitChoiceIndex(provider, sessionId, type),
		);
		return ordered[0] ?? credentials[order[0]];
	}

	#orderByBlockAvailability<C extends { index: number }>(
		provider: string,
		providerKey: string,
		candidates: readonly (C | undefined)[],
		blockScope?: string,
	): C[] {
		const present = candidates.filter((candidate): candidate is C => candidate !== undefined);
		return present
			.map((candidate, position) => ({
				candidate,
				position,
				blockedUntil: this.#getCredentialBlockedUntil(provider, providerKey, candidate.index, blockScope) ?? 0,
			}))
			.sort((left, right) =>
				left.blockedUntil === right.blockedUntil
					? left.position - right.position
					: left.blockedUntil - right.blockedUntil,
			)
			.map(entry => entry.candidate);
	}

	#leadWithChosenAccount<C extends { index: number }>(ordered: C[], chosenIndex: number | undefined): C[] {
		if (chosenIndex === undefined) return ordered;
		const at = ordered.findIndex(candidate => candidate.index === chosenIndex);
		if (at <= 0) return ordered;
		const [chosen] = ordered.splice(at, 1);
		if (chosen) ordered.unshift(chosen);
		return ordered;
	}

	async #rankApiKeySelections(args: {
		providerKey: string;
		provider: string;
		order: number[];
		credentials: ApiKeySelection[];
		options?: AuthApiKeyOptions;
		strategy: CredentialRankingStrategy;
		rankingContext: CredentialRankingContext;
		blockScope?: string;
	}): Promise<ApiKeyCandidate[]> {
		const nowMs = Date.now();
		const { strategy } = args;
		const ranked: RankedApiKeyCandidate[] = [];
		const usageTimeout = Math.max(5000, this.#usageRequestTimeoutMs * 1.5);
		const usagePromise: Promise<Array<UsageRankingResult<ApiKeyCredential> | null>> = Promise.all(
			args.order.map(async idx => {
				const selection = args.credentials[idx];
				if (!selection) return null;
				const blockedUntil = this.#getCredentialBlockedUntil(
					args.provider,
					args.providerKey,
					selection.index,
					args.blockScope,
				);
				if (blockedUntil !== undefined) {
					return { selection, usage: null, usageChecked: false, blockedUntil };
				}
				const usage = await this.#getUsageReport(args.provider, selection.credential, {
					...args.options,
					timeoutMs: this.#usageRequestTimeoutMs,
				});
				return { selection, usage, usageChecked: true, blockedUntil: undefined };
			}),
		);
		const timeoutSignal = Promise.withResolvers<null>();
		const timer = setTimeout(() => timeoutSignal.resolve(null), usageTimeout);
		timer.unref?.();
		const usageResults = await Promise.race([usagePromise, timeoutSignal.promise]).then(result => {
			clearTimeout(timer);
			if (result) return result;
			return args.order.map(idx => {
				const selection = args.credentials[idx];
				if (!selection) return null;
				const blockedUntil = this.#getCredentialBlockedUntil(
					args.provider,
					args.providerKey,
					selection.index,
					args.blockScope,
				);
				return { selection, usage: null, usageChecked: false, blockedUntil };
			});
		});

		for (let orderPos = 0; orderPos < usageResults.length; orderPos += 1) {
			const result = usageResults[orderPos];
			if (!result) continue;
			const { selection, usage, usageChecked } = result;
			let { blockedUntil } = result;
			let blocked = blockedUntil !== undefined;
			const scopedLimits = usage ? this.#getScopedUsageLimits(strategy, usage, args.rankingContext) : undefined;
			if (!blocked && scopedLimits && this.#isUsageLimitReached(scopedLimits)) {
				const resetAtMs = this.#getUsageResetAtMs(scopedLimits, nowMs);
				blockedUntil = resetAtMs ?? Date.now() + AuthStorage.#defaultBackoffMs;
				this.#markCredentialBlocked(
					args.provider,
					args.providerKey,
					selection.index,
					blockedUntil,
					args.blockScope,
				);
				blocked = true;
			}
			const windows = usage ? strategy.findWindowLimits(usage, args.rankingContext) : undefined;
			const primary = windows?.primary;
			const secondary = windows?.secondary;
			const secondaryTarget = secondary ?? primary;
			ranked.push({
				selection,
				usage,
				usageChecked,
				blocked,
				blockedUntil,
				hasPriorityBoost: strategy.hasPriorityBoost?.(primary) ?? false,
				planPriority: 0,
				secondaryUsed: this.#normalizeUsageFraction(secondaryTarget),
				secondaryRequiredDrain: this.#computeWindowRequiredDrain(
					secondaryTarget,
					nowMs,
					strategy.windowDefaults.secondaryMs,
				),
				primaryUsed: this.#normalizeUsageFraction(primary),
				primaryRequiredDrain: this.#computeWindowRequiredDrain(primary, nowMs, strategy.windowDefaults.primaryMs),
				orderPos,
			});
		}
		return this.#orderUsageRankedCandidates(ranked, "none");
	}

	async #selectApiKeyCredential(
		provider: string,
		sessionId: string | undefined,
		options: AuthApiKeyOptions | undefined,
		filter?: (credential: ApiKeyCredential) => boolean,
	): Promise<ApiKeySelection | undefined> {
		const credentials = this.#getCredentialsForProvider(provider)
			.map((credential, index) => ({ credential, index }))
			.filter((entry): entry is ApiKeySelection => {
				if (entry.credential.type !== "api_key") return false;
				return filter?.(entry.credential) ?? true;
			});

		if (credentials.length === 0) return undefined;
		if (credentials.length === 1) return credentials[0];

		const providerKey = this.#getProviderTypeKey(provider, "api_key");
		const order = this.#getCredentialOrder(providerKey, sessionId, credentials.length);
		const fallback = credentials[order[0]];
		const strategy = this.#rankingStrategyResolver?.(provider);
		const chosenIndex = this.#explicitChoiceIndex(provider, sessionId, "api_key");
		const chosen = chosenIndex === undefined ? undefined : credentials.find(entry => entry.index === chosenIndex);
		if (chosen) return chosen;
		if (!strategy) {
			const ordered = this.#orderByBlockAvailability(
				provider,
				providerKey,
				order.map(idx => credentials[idx]),
			);
			return ordered[0] ?? fallback;
		}

		const rankingContext: CredentialRankingContext = { modelId: options?.modelId };
		const blockScope = strategy.blockScope?.(rankingContext);
		const candidates = await this.#rankApiKeySelections({
			providerKey,
			provider,
			order,
			credentials,
			options,
			strategy,
			rankingContext,
			blockScope,
		});
		return candidates[0]?.selection ?? fallback;
	}

	#clearProviderSessionCredentialCache(provider: string): void {
		try {
			this.#store.deleteCachePrefix?.(`${SESSION_STICKY_CACHE_PREFIX}${provider}:`);
		} catch (err) {
			this.#reportStickyCacheFailure("clear-provider", provider, err);
		}
	}

	#resetProviderAssignments(provider: string): void {
		for (const key of this.#providerRoundRobinIndex.keys()) {
			if (key.startsWith(`${provider}:`)) {
				this.#providerRoundRobinIndex.delete(key);
			}
		}
		this.#sessionLastCredential.delete(provider);
		this.#clearProviderSessionCredentialCache(provider);
		for (const key of this.#credentialBackoff.keys()) {
			if (key.startsWith(`${provider}:`)) {
				this.#credentialBackoff.delete(key);
			}
		}
	}

	#replaceCredentialAt(provider: string, index: number, credential: AuthCredential): void {
		const entries = this.#getStoredCredentials(provider);
		if (index < 0 || index >= entries.length) return;
		const target = entries[index];
		this.#store.updateAuthCredential(target.id, credential);
		this.#authDeadCredentials.delete(target.id);
		const updated = entries.slice();
		updated[index] = { id: target.id, credential };
		this.#setStoredCredentials(provider, updated);
	}

	#tryDisableCredentialAtIfMatches(
		provider: string,
		index: number,
		expectedCredential: AuthCredential,
		disabledCause: string,
	): boolean {
		const entries = this.#getStoredCredentials(provider);
		if (index < 0 || index >= entries.length) return false;
		const target = entries[index];
		const serialized = serializeCredential(provider, expectedCredential);
		if (!serialized) return false;
		const disabled = this.#store.tryDisableAuthCredentialIfMatches(target.id, serialized.data, disabledCause);
		if (!disabled) return false;
		const updated = entries.filter((_value, idx) => idx !== index);
		this.#setStoredCredentials(provider, updated);
		this.#resetProviderAssignments(provider);
		this.#emitCredentialDisabled({ provider, disabledCause });
		return true;
	}

	#persistRefreshedCredentialById(provider: string, id: number, credential: AuthCredential): number {
		const readById = this.#store.readAuthCredentialById?.bind(this.#store);
		if (readById) {
			const latest = readById(id);
			if (!latest) return -1;
			if (!isRefreshFailureDisableCause(latest.disabledCause)) return -1;
		}

		const alreadyStored = readById?.(id);
		const inMemory = this.#getStoredCredentials(provider).find(entry => entry.id === id);
		const unchanged = alreadyStored
			? alreadyStored.disabledCause === null && authCredentialEquals(alreadyStored.credential, credential)
			: inMemory !== undefined && authCredentialEquals(inMemory.credential, credential);

		if (!unchanged) {
			const enabling = this.#store.updateAuthCredentialEnabling?.bind(this.#store);
			if (enabling) enabling(id, credential);
			else this.#store.updateAuthCredential(id, credential);
		}

		const entries = this.#getStoredCredentials(provider);
		const index = entries.findIndex(entry => entry.id === id);
		if (index === -1) {
			const refreshed = this.#store.listAuthCredentials(provider);
			this.#setStoredCredentials(
				provider,
				refreshed.map(row => ({ id: row.id, credential: row.credential })),
			);
			return this.#getStoredCredentials(provider).findIndex(entry => entry.id === id);
		}
		const updated = entries.slice();
		updated[index] = { id, credential };
		this.#setStoredCredentials(provider, updated);
		return index;
	}

	#disableCredentialByIdIfMatches(
		provider: string,
		id: number,
		expected: AuthCredential,
		disabledCause: string,
	): boolean {
		const entries = this.#getStoredCredentials(provider);
		const index = entries.findIndex(entry => entry.id === id);
		if (index === -1) return false;
		return this.#tryDisableCredentialAtIfMatches(provider, index, expected, disabledCause);
	}

	#emitCredentialDisabled(event: CredentialDisabledEvent): void {
		if (this.#credentialDisabledListeners.size === 0) {
			if (this.#pendingDisabledEvents.length >= MAX_PENDING_DISABLED_EVENTS) {
				this.#pendingDisabledEvents.shift();
			}
			this.#pendingDisabledEvents.push(event);
			return;
		}
		const listeners = Array.from(this.#credentialDisabledListeners);
		for (const listener of listeners) {
			this.#invokeListener(listener, event);
		}
	}

	#invokeListener(
		listener: (event: CredentialDisabledEvent) => void | Promise<void>,
		event: CredentialDisabledEvent,
	): void {
		const logListenerError = (error: unknown): void => {
			logger.warn("onCredentialDisabled listener threw", { provider: event.provider, error: String(error) });
		};
		try {
			const result = listener(event);
			if (result && typeof (result as PromiseLike<void>).then === "function") {
				(result as Promise<void>).catch(logListenerError);
			}
		} catch (error) {
			logListenerError(error);
		}
	}

	get(provider: string): AuthCredential | undefined {
		return this.#getCredentialsForProvider(provider)[0];
	}

	async set(provider: string, credential: AuthCredentialEntry): Promise<void> {
		const normalized = Array.isArray(credential) ? credential : [credential];
		const deduped = this.#dedupeOAuthCredentials(provider, normalized);
		const stored = this.#store.replaceAuthCredentialsRemote
			? await this.#store.replaceAuthCredentialsRemote(provider, deduped)
			: this.#store.replaceAuthCredentialsForProvider(provider, deduped);
		this.#setStoredCredentials(
			provider,
			stored.map(record => ({ id: record.id, credential: record.credential })),
		);
		this.#resetProviderAssignments(provider);
	}

	listStoredCredentials(provider?: string): StoredAuthCredential[] {
		if (provider !== undefined) {
			return this.#getStoredCredentials(provider).map(entry => ({
				id: entry.id,
				provider,
				credential: entry.credential,
				disabledCause: null,
			}));
		}
		const rows: StoredAuthCredential[] = [];
		for (const [storedProvider, entries] of this.#data) {
			for (const entry of entries) {
				rows.push({
					id: entry.id,
					provider: storedProvider,
					credential: entry.credential,
					disabledCause: null,
				});
			}
		}
		return rows;
	}

	async refreshStoredOAuthCredential<T extends OAuthCredential = OAuthCredential>(
		provider: string,
		options: StoredOAuthRefreshOptions<T>,
	): Promise<StoredOAuthRefreshResult<T>> {
		const refreshSkewMs = options.refreshSkewMs ?? OAUTH_REFRESH_SKEW_MS;
		const hasDurableLease =
			!!this.#store.tryAcquireCredentialRefreshLease &&
			!!this.#store.getCredentialRefreshLeaseExpiresAt &&
			!!this.#store.releaseCredentialRefreshLease &&
			!!this.#store.renewCredentialRefreshLease;
		const owner = crypto.randomUUID();
		let leasedCredentialId: number | undefined;

		while (hasDurableLease) {
			if (options.signal?.aborted) throw new AIError.RequestAbortError("OAuth refresh ownership aborted by caller");
			const rows = this.#store.listAuthCredentials(provider);
			this.#setStoredCredentials(
				provider,
				rows.map(row => ({ id: row.id, credential: row.credential })),
			);
			const row = rows.find(entry => entry.credential.type === "oauth");
			if (row?.credential.type !== "oauth") {
				return { credential: undefined, refreshed: false, removed: false };
			}
			const current = options.credentialFromRow(row.credential);
			if (!current) {
				return { credential: undefined, refreshed: false, removed: false };
			}
			if (options.observedCredential && !authCredentialEquals(current, options.observedCredential)) {
				return { credential: current, refreshed: false, removed: false };
			}
			if (!options.forceRefresh && Date.now() + refreshSkewMs < current.expires) {
				return { credential: current, refreshed: false, removed: false };
			}
			if (options.canRefresh && !options.canRefresh(current)) {
				return { credential: current, refreshed: false, removed: false };
			}
			if (this.#store.tryAcquireCredentialRefreshLease?.(row.id, owner, Date.now() + OAUTH_REFRESH_LEASE_TTL_MS)) {
				leasedCredentialId = row.id;
				break;
			}
			const leaseExpiresAt = this.#store.getCredentialRefreshLeaseExpiresAt?.(row.id);
			const waitMs =
				leaseExpiresAt === undefined
					? OAUTH_REFRESH_LEASE_POLL_MS
					: clamp(leaseExpiresAt - Date.now(), OAUTH_REFRESH_LEASE_POLL_MS, 250);
			await raceCredentialRefreshWithSignal(
				Bun.sleep(waitMs),
				options.signal,
				"OAuth refresh ownership wait aborted by caller",
			);
		}

		try {
			const rows = this.#store.listAuthCredentials(provider);
			this.#setStoredCredentials(
				provider,
				rows.map(row => ({ id: row.id, credential: row.credential })),
			);
			const row = rows.find(entry => entry.credential.type === "oauth");
			if (row?.credential.type !== "oauth") {
				return { credential: undefined, refreshed: false, removed: false };
			}
			const current = options.credentialFromRow(row.credential);
			if (!current) {
				return { credential: undefined, refreshed: false, removed: false };
			}
			if (options.observedCredential && !authCredentialEquals(current, options.observedCredential)) {
				return { credential: current, refreshed: false, removed: false };
			}
			if (!options.forceRefresh && Date.now() + refreshSkewMs < current.expires) {
				return { credential: current, refreshed: false, removed: false };
			}
			if (options.canRefresh && !options.canRefresh(current)) {
				return { credential: current, refreshed: false, removed: false };
			}
			const serialized = serializeCredential(provider, current);
			if (!serialized) return { credential: current, refreshed: false, removed: false };

			const refreshAbort = new AbortController();
			const refreshTimeout = setTimeout(() => {
				refreshAbort.abort(
					new AIError.OAuthError(`OAuth token refresh timed out for provider: ${provider}`, {
						kind: "timeout",
						provider,
					}),
				);
			}, options.refreshTimeoutMs ?? OAUTH_REFRESH_OPERATION_TIMEOUT_MS);

			type RefreshStep =
				| { kind: "refreshed"; credentials: OAuthCredentials }
				| { kind: "done"; result: StoredOAuthRefreshResult<T> };
			let step: RefreshStep;
			let leaseRenewalError: unknown;
			try {
				({ result: step, ownershipLost: leaseRenewalError } = await this.#withRefreshLeaseRenewal<RefreshStep>(
					leasedCredentialId,
					owner,
					async () => {
						try {
							return { kind: "refreshed", credentials: await options.refresh(current, refreshAbort.signal) };
						} catch (error) {
							if (options.isDefinitiveFailure?.(error)) {
								const disabledCause =
									options.disabledCause?.(error) ?? `oauth refresh failed: ${String(error)}`;
								const disabled = this.#store.tryDisableAuthCredentialIfMatches(
									row.id,
									serialized.data,
									disabledCause,
									leasedCredentialId !== undefined ? { owner, nowMs: Date.now() } : undefined,
								);
								if (disabled) {
									this.#setStoredCredentials(
										provider,
										rows
											.filter(entry => entry.id !== row.id)
											.map(entry => ({ id: entry.id, credential: entry.credential })),
									);
									this.#resetProviderAssignments(provider);
									this.#emitCredentialDisabled({ provider, disabledCause });
									return { kind: "done", result: { credential: undefined, refreshed: false, removed: true } };
								}
								await this.reload();
								const latest = this.get(provider);
								return {
									kind: "done",
									result: {
										credential: latest?.type === "oauth" ? options.credentialFromRow(latest) : undefined,
										refreshed: false,
										removed: false,
									},
								};
							}
							options.onRefreshFailure?.(error);
							const keepCredential =
								typeof options.keepCredentialOnRefreshFailure === "function"
									? options.keepCredentialOnRefreshFailure(error)
									: options.keepCredentialOnRefreshFailure === true;
							if (keepCredential) {
								return { kind: "done", result: { credential: current, refreshed: false, removed: false } };
							}
							throw error;
						}
					},
				));
			} finally {
				clearTimeout(refreshTimeout);
			}
			if (step.kind === "done") return step.result;
			const refreshed = step.credentials;
			const lostLeaseOwnership = leaseRenewalError !== undefined;
			if (lostLeaseOwnership) {
				logger.warn("OAuth refresh lease lost mid-rotation; persisting on the data CAS alone", {
					provider,
					credentialId: row.id,
				});
			}
			const persistLease =
				leasedCredentialId !== undefined && !lostLeaseOwnership ? { owner, nowMs: Date.now() } : undefined;

			const merged: T = options.mergeRefreshedCredential
				? options.mergeRefreshedCredential(current, refreshed)
				: {
						...current,
						access: refreshed.access,
						refresh: refreshed.refresh,
						expires: refreshed.expires,
						accountId: refreshed.accountId ?? current.accountId,
						email: refreshed.email ?? current.email,
						projectId: refreshed.projectId ?? current.projectId,
						enterpriseUrl: refreshed.enterpriseUrl ?? current.enterpriseUrl,
						apiEndpoint: refreshed.apiEndpoint ?? current.apiEndpoint,
						orgId: refreshed.orgId ?? current.orgId,
						orgName: refreshed.orgName ?? current.orgName,
					};
			if (this.#store.tryUpdateAuthCredentialIfMatches) {
				if (!this.#store.tryUpdateAuthCredentialIfMatches(row.id, serialized.data, merged, persistLease)) {
					await this.reload();
					const latest = this.get(provider);
					return {
						credential: latest?.type === "oauth" ? options.credentialFromRow(latest) : undefined,
						refreshed: false,
						removed: false,
					};
				}
			} else {
				this.#store.updateAuthCredential(row.id, merged);
			}
			this.#setStoredCredentials(
				provider,
				rows.map(entry => ({ id: entry.id, credential: entry.id === row.id ? merged : entry.credential })),
			);
			return { credential: merged, refreshed: true, removed: false };
		} finally {
			if (leasedCredentialId !== undefined) {
				this.#store.releaseCredentialRefreshLease?.(leasedCredentialId, owner);
			}
		}
	}

	async #upsertOAuthCredential(provider: string, credential: OAuthCredential): Promise<number | undefined> {
		const stored = this.#store.upsertAuthCredentialRemote
			? await this.#store.upsertAuthCredentialRemote(provider, credential)
			: this.#store.upsertAuthCredentialForProvider(provider, credential);
		this.#setStoredCredentials(
			provider,
			stored.map(entry => ({ id: entry.id, credential: entry.credential })),
		);
		this.#resetProviderAssignments(provider);
		return matchStoredCredentialId(stored, credential);
	}

	async remove(provider: string): Promise<void> {
		if (this.#store.deleteAuthCredentialsRemote) {
			await this.#store.deleteAuthCredentialsRemote(provider, "deleted by user");
		} else {
			this.#store.deleteAuthCredentialsForProvider(provider, "deleted by user");
		}
		this.#setStoredCredentials(provider, []);
		this.#resetProviderAssignments(provider);
	}

	async removeCredential(provider: string, credentialId: number): Promise<boolean> {
		const entries = this.#getStoredCredentials(provider);
		const index = entries.findIndex(entry => entry.id === credentialId);
		if (index === -1) return false;

		if (this.#store.deleteAuthCredentialRemote) {
			const deleted = await this.#store.deleteAuthCredentialRemote(credentialId, "deleted by user");
			if (!deleted) return false;
		} else {
			this.#store.deleteAuthCredential(credentialId, "deleted by user");
		}
		this.#setStoredCredentials(
			provider,
			entries.filter((_entry, entryIndex) => entryIndex !== index),
		);
		this.#resetProviderAssignments(provider);
		return true;
	}

	list(): string[] {
		return Array.from(this.#data.keys());
	}

	has(provider: string): boolean {
		return this.#getCredentialsForProvider(provider).length > 0;
	}

	disabledCredentialCause(provider: string): string | undefined {
		const listDisabled = this.#store.listDisabledAuthCredentials?.bind(this.#store);
		if (!listDisabled) return undefined;
		const [latest] = listDisabled(provider);
		if (!latest?.disabledCause) return undefined;
		return isRefreshFailureDisableCause(latest.disabledCause) ? latest.disabledCause : undefined;
	}

	listProvidersWithFailedRefresh(): Array<{ provider: string; cause: string }> {
		const listDisabled = this.#store.listDisabledAuthCredentials?.bind(this.#store);
		if (!listDisabled) return [];
		const seen = new Set<string>();
		const failures: Array<{ provider: string; cause: string }> = [];
		for (const row of listDisabled()) {
			if (seen.has(row.provider)) continue;
			seen.add(row.provider);
			if (row.disabledCause && isRefreshFailureDisableCause(row.disabledCause)) {
				failures.push({ provider: row.provider, cause: row.disabledCause });
			}
		}
		return failures;
	}

	hasAuth(provider: string): boolean {
		if (this.#runtimeOverrides.has(provider)) return true;
		if (this.#configOverrides.has(provider)) return true;
		if (this.#getCredentialsForProvider(provider).length > 0) return true;
		if (getEnvApiKey(provider)) return true;
		if (this.#fallbackResolver?.(provider)) return true;
		return false;
	}

	hasNonEnvCredential(provider: string): boolean {
		if (this.#runtimeOverrides.has(provider)) return true;
		if (this.#configOverrides.has(provider)) return true;
		if (this.#getCredentialsForProvider(provider).length > 0) return true;
		if (this.#fallbackResolver?.(provider)) return true;
		return false;
	}

	getCredentialOrigin(provider: string): CredentialOrigin | undefined {
		if (this.#runtimeOverrides.has(provider)) return { kind: "runtime" };
		if (this.#configOverrides.has(provider)) return { kind: "config" };
		const stored = this.#getCredentialsForProvider(provider);
		if (stored.some(credential => credential.type === "oauth")) return { kind: "oauth" };
		if (stored.some(credential => credential.type === "api_key" && credential.source === "login")) {
			return { kind: "api_key" };
		}
		if (getEnvApiKey(provider)) return { kind: "env", envVar: getEnvApiKeyName(provider) };
		if (stored.some(credential => credential.type === "api_key")) return { kind: "api_key" };
		if (this.#fallbackResolver?.(provider)) return { kind: "fallback" };
		return undefined;
	}

	hasOAuth(provider: string): boolean {
		return this.#getCredentialsForProvider(provider).some(credential => credential.type === "oauth");
	}

	getOAuthCredential(provider: string): OAuthCredential | undefined {
		return this.#getCredentialsForProvider(provider).find(
			(credential): credential is OAuthCredential => credential.type === "oauth",
		);
	}

	#resolveActiveOAuthCredential(provider: string, sessionId?: string): OAuthCredential | undefined {
		const allCredentials = this.#getCredentialsForProvider(provider);
		const oauthCredentials = allCredentials.filter((c): c is OAuthCredential => c.type === "oauth");
		if (oauthCredentials.length === 0) return undefined;

		if (this.#runtimeOverrides.has(provider) || this.#configOverrides.has(provider)) return undefined;

		const sessionPref = this.#getSessionCredential(provider, sessionId);
		if (sessionPref !== undefined && sessionPref.type !== "oauth") return undefined;

		if (!sessionPref && (getEnvApiKey(provider) || this.#fallbackResolver?.(provider))) return undefined;
		const stickyCredential = sessionPref?.type === "oauth" ? allCredentials[sessionPref.index] : undefined;
		return stickyCredential?.type === "oauth" ? stickyCredential : oauthCredentials[0];
	}

	getOAuthAccountId(provider: string, sessionId?: string): string | undefined {
		const preferred = this.#resolveActiveOAuthCredential(provider, sessionId);
		const accountId = preferred?.accountId;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	}

	getOAuthAccountIdentity(provider: string, sessionId?: string): OAuthAccountIdentity | undefined {
		const preferred = this.#resolveActiveOAuthCredential(provider, sessionId);
		if (!preferred) return undefined;
		const identity: OAuthAccountIdentity = {};
		if (typeof preferred.accountId === "string" && preferred.accountId.length > 0) {
			identity.accountId = preferred.accountId;
		}
		if (typeof preferred.email === "string" && preferred.email.length > 0) {
			identity.email = preferred.email;
		}
		if (typeof preferred.projectId === "string" && preferred.projectId.length > 0) {
			identity.projectId = preferred.projectId;
		}
		if (typeof preferred.orgId === "string" && preferred.orgId.length > 0) {
			identity.orgId = preferred.orgId;
		}
		if (typeof preferred.orgName === "string" && preferred.orgName.length > 0) {
			identity.orgName = preferred.orgName;
		}
		if (!identity.accountId && !identity.email && !identity.projectId && !identity.orgId) return undefined;
		return identity;
	}

	getAll(): AuthStorageData {
		const result: AuthStorageData = {};
		for (const [provider, entries] of this.#data.entries()) {
			const credentials = entries.map(entry => entry.credential);
			if (credentials.length === 1) {
				result[provider] = credentials[0];
			} else if (credentials.length > 1) {
				result[provider] = credentials;
			}
		}
		return result;
	}

	async login(
		provider: OAuthProviderId,
		ctrl: OAuthController & {
			onAuth: (info: OAuthAuthInfo) => void;
			onPrompt: (prompt: OAuthPrompt) => Promise<string>;
		},
	): Promise<OAuthLoginIdentity | undefined> {
		const manualCodeInput = PASTE_CODE_LOGIN_PROVIDERS.has(provider)
			? () => ctrl.onPrompt({ message: "Paste the authorization code (or full redirect URL):", secret: true })
			: undefined;
		const def = getProviderDefinition(provider) ?? getOAuthProvider(provider);
		if (!def?.login) {
			throw new AIError.ConfigurationError(`Unknown OAuth provider: ${provider}`);
		}
		const result = await def.login({
			onAuth: ctrl.onAuth,
			onProgress: ctrl.onProgress,
			onPrompt: ctrl.onPrompt,
			onManualCodeInput: ctrl.onManualCodeInput ?? manualCodeInput,
			onSuccessPage: ctrl.onSuccessPage,
			signal: ctrl.signal,
			fetch: ctrl.fetch,
		});
		const target = def.storeCredentialsAs ?? provider;
		if (typeof result === "string") {
			// Some flows (e.g. ollama) return "" to signal that no key was entered.
			if (!result) {
				return undefined;
			}
			const newCredential: ApiKeyCredential = { type: "api_key", key: result, source: "login" };
			const stored = this.#store.upsertAuthCredentialRemote
				? await this.#store.upsertAuthCredentialRemote(target, newCredential)
				: this.#store.upsertAuthCredentialForProvider(target, newCredential);
			this.#setStoredCredentials(
				target,
				stored.map(entry => ({ id: entry.id, credential: entry.credential })),
			);
			this.#resetProviderAssignments(target);
			const credentialId = matchStoredCredentialId(stored, newCredential);
			return { type: "api_key", ...(credentialId !== undefined ? { credentialId } : {}) };
		}
		const newCredential: OAuthCredential = { type: "oauth", ...result };
		const credentialId = await this.#upsertOAuthCredential(target, newCredential);
		return {
			type: "oauth",
			email: newCredential.email,
			accountId: newCredential.accountId,
			orgId: newCredential.orgId,
			orgName: newCredential.orgName,
			...(credentialId !== undefined ? { credentialId } : {}),
		};
	}

	async logout(provider: string): Promise<void> {
		await this.remove(provider);
	}

	#buildUsageCredential(credential: AuthCredential): UsageCredential {
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

	#buildUsageCacheIdentity(credential: UsageCredential): string {
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

	#normalizeUsageBaseUrl(baseUrl?: string): string {
		return baseUrl ? trimTrailingSlashes(baseUrl.trim()) : "";
	}

	#buildUsageReportCacheKey(request: UsageRequestDescriptor): string {
		const baseUrl = this.#normalizeUsageBaseUrl(request.baseUrl) || "default";
		const identity = this.#buildUsageCacheIdentity(request.credential);
		const versionOverride = USAGE_REPORT_CACHE_KEY_VERSION_OVERRIDES[request.provider];
		const providerKey = versionOverride === undefined ? request.provider : `${versionOverride}:${request.provider}`;
		return `report:${providerKey}:${baseUrl}:${identity}`;
	}

	#buildUsageReportsCacheKey(requests: ReadonlyArray<UsageRequestDescriptor>): string {
		const snapshot = requests
			.map(request => {
				const versionOverride = USAGE_REPORT_CACHE_KEY_VERSION_OVERRIDES[request.provider];
				const providerKey =
					versionOverride === undefined ? request.provider : `${versionOverride}:${request.provider}`;
				return `${providerKey}:${this.#normalizeUsageBaseUrl(request.baseUrl) || "default"}:${this.#buildUsageCacheIdentity(request.credential)}`;
			})
			.sort()
			.join("\n");
		return `reports:${Bun.hash(snapshot).toString(16)}`;
	}

	#buildUsageRequest(provider: Provider, credential: UsageCredential, baseUrl?: string): UsageRequestDescriptor {
		return { provider, credential, baseUrl };
	}

	#buildUsageRequestForOauth(
		provider: Provider,
		credential: OAuthCredential,
		baseUrl?: string,
	): UsageRequestDescriptor {
		return this.#buildUsageRequest(provider, this.#buildUsageCredential(credential), baseUrl);
	}

	#buildRefreshableOauthCredential(credential: UsageCredential): OAuthCredential | null {
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

	#buildCompletionProbeCredential(credential: UsageCredential): CompletionProbeCredential | null {
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

	#mergeRefreshedUsageCredential(credential: UsageCredential, refreshed: OAuthCredentials): UsageCredential {
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

	#findStoredCredentialIdForUsageCredential(provider: Provider, previous: UsageCredential): number | undefined {
		const entries = this.#getStoredCredentials(provider);
		const previousRefresh =
			previous.refreshToken && previous.refreshToken !== REMOTE_REFRESH_SENTINEL ? previous.refreshToken : undefined;
		const match = entries.find(entry => {
			if (entry.credential.type !== "oauth") return false;
			if (previousRefresh && entry.credential.refresh === previousRefresh) return true;
			if (previous.accessToken && entry.credential.access === previous.accessToken) return true;
			return (
				entry.credential.accountId === previous.accountId &&
				entry.credential.email === previous.email &&
				entry.credential.projectId === previous.projectId &&
				entry.credential.orgId === previous.orgId
			);
		});
		return match?.id;
	}

	#persistRefreshedUsageCredential(provider: Provider, previous: UsageCredential, next: UsageCredential): void {
		const entries = this.#getStoredCredentials(provider);
		const previousRefresh =
			previous.refreshToken && previous.refreshToken !== REMOTE_REFRESH_SENTINEL ? previous.refreshToken : undefined;
		const index = entries.findIndex(entry => {
			if (entry.credential.type !== "oauth") return false;
			if (previousRefresh && entry.credential.refresh === previousRefresh) return true;
			if (previous.accessToken && entry.credential.access === previous.accessToken) return true;
			return (
				entry.credential.accountId === previous.accountId &&
				entry.credential.email === previous.email &&
				entry.credential.projectId === previous.projectId &&
				entry.credential.orgId === previous.orgId
			);
		});
		if (index === -1) return;
		const existing = entries[index]!.credential;
		if (existing.type !== "oauth") return;
		this.#replaceCredentialAt(provider, index, {
			type: "oauth",
			access: next.accessToken ?? existing.access,
			refresh: next.refreshToken ?? existing.refresh,
			expires: next.expiresAt ?? existing.expires,
			accountId: next.accountId,
			projectId: next.projectId,
			email: next.email,
			enterpriseUrl: next.enterpriseUrl,
			apiEndpoint: next.apiEndpoint,
			orgId: next.orgId ?? existing.orgId,
			orgName: next.orgName ?? existing.orgName,
		});
	}

	async #fetchUsageUncached(request: UsageRequestDescriptor, timeoutMs?: number): Promise<UsageReport | null> {
		const scopedTimeout =
			typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
				? scopedTimeoutSignal(timeoutMs)
				: undefined;
		try {
			return await this.#fetchUsageUncachedWithSignal(request, scopedTimeout?.signal);
		} finally {
			scopedTimeout?.cancel();
		}
	}

	async #fetchUsageUncachedWithSignal(
		request: UsageRequestDescriptor,
		timeoutSignal: AbortSignal | undefined,
	): Promise<UsageReport | null> {
		const resolver = this.#usageProviderResolver;
		if (!resolver) return null;

		const providerImpl = resolver(request.provider);
		if (!providerImpl) return null;

		let params: UsageFetchParams = {
			...request,
			accountKey: this.#buildUsageCacheIdentity(request.credential),
			signal: timeoutSignal,
		};

		if (
			request.credential.type === "oauth" &&
			request.credential.expiresAt !== undefined &&
			Date.now() + OAUTH_REFRESH_SKEW_MS >= request.credential.expiresAt
		) {
			const refreshableCredential = this.#buildRefreshableOauthCredential(request.credential);
			if (refreshableCredential) {
				try {
					const refreshableCredentialId = this.#findStoredCredentialIdForUsageCredential(
						request.provider,
						request.credential,
					);
					const refreshed = await this.#refreshOAuthCredential(
						request.provider,
						refreshableCredential,
						refreshableCredentialId,
						timeoutSignal,
					);
					const refreshedCredential = this.#mergeRefreshedUsageCredential(request.credential, refreshed);
					this.#persistRefreshedUsageCredential(request.provider, request.credential, refreshedCredential);
					params = {
						...request,
						credential: refreshedCredential,
						accountKey: this.#buildUsageCacheIdentity(refreshedCredential),
						signal: timeoutSignal,
					};
				} catch (error) {
					const errorMsg = String(error);
					if (AIError.isDefinitiveOAuthFailure(errorMsg)) {
						const credentialId = this.#findStoredCredentialIdForUsageCredential(
							request.provider,
							request.credential,
						);
						if (credentialId !== undefined) {
							const entries = this.#getStoredCredentials(request.provider);
							const index = entries.findIndex(entry => entry.id === credentialId);
							if (index !== -1) {
								const disabled = this.#tryDisableCredentialAtIfMatches(
									request.provider,
									index,
									refreshableCredential,
									`oauth refresh failed during usage probe: ${errorMsg}`,
								);
								if (disabled) {
									this.#usageLogger?.warn(
										"Usage credential refresh failed definitively; credential disabled",
										{ provider: request.provider, credentialId, error: errorMsg },
									);
									this.#usageCache.set(this.#buildUsageReportCacheKey(request), {
										value: null,
										expiresAt: 0,
									});
									return null;
								}
							}
						}
					}
					this.#usageLogger?.debug("Usage credential refresh failed, using original credential", {
						provider: request.provider,
						error: errorMsg,
					});
				}
			}
		}

		if (providerImpl.supports && !providerImpl.supports(params)) return null;

		try {
			const report = await providerImpl.fetchUsage(params, {
				fetch: this.#usageFetch,
				logger: this.#usageLogger,
				listUsageCosts: query => this.#store.listUsageCosts?.(query) ?? [],
			});
			if (report && params.credential.orgId !== undefined) {
				const metadata = report.metadata ?? {};
				const sameOrg = metadata.orgId === undefined || metadata.orgId === params.credential.orgId;
				const needsOrgId = metadata.orgId === undefined;
				const needsOrgName = sameOrg && params.credential.orgName !== undefined && metadata.orgName === undefined;
				if (needsOrgId || needsOrgName) {
					report.metadata = {
						...metadata,
						...(needsOrgId ? { orgId: params.credential.orgId } : {}),
						...(needsOrgName ? { orgName: params.credential.orgName } : {}),
					};
				}
			}
			return report;
		} catch (error) {
			logger.debug("AuthStorage usage fetch failed", {
				provider: request.provider,
				error: String(error),
			});
			return null;
		}
	}

	async #fetchUsageCached(request: UsageRequestDescriptor, timeoutMs?: number): Promise<UsageReport | null> {
		const cacheKey = this.#buildUsageReportCacheKey(request);
		const now = Date.now();
		const cached = this.#usageCache.get<UsageReport | null>(cacheKey);
		if (cached && cached.expiresAt > now) {
			return cached.value;
		}

		const inFlight = this.#usageRequestInFlight.get(cacheKey);
		if (inFlight) return inFlight;

		const usageCacheEpoch = this.#usageCacheEpoch;
		const promise = (async () => {
			const report = await withAuthHttpConcurrency(() => this.#fetchUsageUncached(request, timeoutMs));
			if (usageCacheEpoch !== this.#usageCacheEpoch) return report;
			const ttlJitter = USAGE_REPORT_TTL_MS * (Math.random() * 0.5 - 0.25);
			if (report !== null) {
				this.#usageCache.set(cacheKey, { value: report, expiresAt: Date.now() + USAGE_REPORT_TTL_MS + ttlJitter });
				this.#recordUsageHistory(request, report);
				this.#reconcileCodexUsageBlock(request, report);
				return report;
			}
			const lastGood = this.#usageCache.getStale<UsageReport | null>(cacheKey)?.value ?? null;
			const backoffJitter = USAGE_FAILURE_BACKOFF_MS * (Math.random() * 0.5 - 0.25);
			const coolDown = Date.now() + USAGE_FAILURE_BACKOFF_MS + backoffJitter;
			this.#usageCache.set(cacheKey, { value: lastGood, expiresAt: coolDown });
			return lastGood;
		})().finally(() => {
			this.#usageRequestInFlight.delete(cacheKey);
		});

		this.#usageRequestInFlight.set(cacheKey, promise);
		return promise;
	}

	#recordUsageHistory(request: UsageRequestDescriptor, report: UsageReport): void {
		const record = this.#store.recordUsageSnapshots;
		if (!record || report.limits.length === 0) return;
		const recordedAt = Number.isFinite(report.fetchedAt) && report.fetchedAt > 0 ? report.fetchedAt : Date.now();
		const accountKey = this.#buildUsageCacheIdentity(request.credential);
		const metadata = report.metadata ?? {};
		const metaEmail = typeof metadata.email === "string" ? metadata.email : undefined;
		const metaAccountId = typeof metadata.accountId === "string" ? metadata.accountId : undefined;
		const entries: UsageHistoryEntry[] = report.limits.map(limit => ({
			recordedAt,
			provider: request.provider,
			accountKey,
			email: request.credential.email ?? metaEmail,
			accountId: request.credential.accountId ?? limit.scope.accountId ?? metaAccountId,
			limitId: limit.id,
			label: limit.label,
			windowLabel: limit.window?.label ?? limit.scope.windowId,
			usedFraction: resolveUsedFraction(limit),
			status: limit.status,
			resetsAt: limit.window?.resetsAt,
		}));
		try {
			record.call(this.#store, entries);
		} catch (error) {
			this.#usageLogger?.debug("usage history record failed", {
				provider: request.provider,
				error: String(error),
			});
		}
	}

	listUsageHistory(query?: UsageHistoryQuery): UsageHistoryEntry[] {
		return this.#store.listUsageHistory?.(query) ?? [];
	}

	recordUsageCost(
		provider: Provider,
		costUsd: number,
		options?: { sessionId?: string; recordedAt?: number; baseUrl?: string },
	): boolean {
		if (!Number.isFinite(costUsd) || costUsd <= 0) return false;
		const record = this.#store.recordUsageCosts;
		if (!record) return false;
		const credential = this.#resolveObservedUsageCredential(provider, options?.sessionId);
		if (!credential) return false;
		const entry: UsageCostHistoryEntry = {
			recordedAt: options?.recordedAt ?? Date.now(),
			provider,
			accountKey: this.#buildUsageCacheIdentity(credential),
			costUsd,
		};
		try {
			record.call(this.#store, [entry]);
			const cacheKey = this.#buildUsageReportCacheKey({
				provider,
				credential,
				baseUrl: options?.baseUrl,
			});
			const existing = this.#usageCache.getStale<UsageReport | null>(cacheKey);
			this.#usageCache.set(cacheKey, { value: existing?.value ?? null, expiresAt: Date.now() - 1 });
			return true;
		} catch (error) {
			this.#usageLogger?.debug("usage cost record failed", {
				provider,
				error: String(error),
			});
			return false;
		}
	}

	#resolveObservedUsageCredential(provider: Provider, sessionId?: string): UsageCredential | undefined {
		const entries = this.#getStoredCredentials(provider);
		const sessionCredential = this.#getSessionCredential(provider, sessionId);
		if (sessionCredential) {
			const credential = entries[sessionCredential.index]?.credential;
			if (credential) {
				return credential.type === "api_key"
					? { type: "api_key", apiKey: credential.key }
					: this.#buildUsageCredential(credential);
			}
		}
		if (entries.length === 1) {
			const credential = entries[0]!.credential;
			return credential.type === "api_key"
				? { type: "api_key", apiKey: credential.key }
				: this.#buildUsageCredential(credential);
		}
		const envKey = getEnvApiKey(provider);
		if (envKey) return { type: "api_key", apiKey: envKey };
		return undefined;
	}

	ingestUsageHeaders(
		provider: Provider,
		headers: Record<string, string>,
		options?: { sessionId?: string; baseUrl?: string },
	): boolean {
		if (this.#fetchUsageReportsOverride) return false;
		const parseHeaders = this.#usageProviderResolver?.(provider)?.parseRateLimitHeaders;
		if (!parseHeaders) return false;

		const credential = this.#resolveActiveOAuthCredential(provider, options?.sessionId);
		if (!credential) return false;

		const cacheKey = this.#buildUsageReportCacheKey(
			this.#buildUsageRequestForOauth(provider, credential, options?.baseUrl),
		);
		const now = Date.now();
		const parsedReport = parseHeaders(headers, now);
		if (!parsedReport) return false;
		const exhausted = parsedReport.limits.some(limit => this.#isUsageLimitExhausted(limit));
		const last = this.#usageHeaderIngestAt.get(cacheKey);
		if (!exhausted && last !== undefined && now - last < USAGE_HEADER_INGEST_INTERVAL_MS) return false;
		const metadata: Record<string, unknown> = { ...(parsedReport.metadata ?? {}) };
		if (credential.accountId && metadata.accountId === undefined) metadata.accountId = credential.accountId;
		if (credential.email && metadata.email === undefined) metadata.email = credential.email;
		if (credential.projectId && metadata.projectId === undefined) metadata.projectId = credential.projectId;
		if (credential.orgId && metadata.orgId === undefined) metadata.orgId = credential.orgId;
		if (credential.orgName && metadata.orgName === undefined) metadata.orgName = credential.orgName;
		const report: UsageReport = { ...parsedReport, metadata };

		const storeIngest = this.#store.ingestUsageReport?.bind(this.#store);
		if (storeIngest) {
			const ingested = storeIngest(provider, credential, report);
			if (ingested) this.#usageHeaderIngestAt.set(cacheKey, now);
			return ingested;
		}

		if (this.#fetchUsageReportsOverride || this.#store.fetchUsageReports) return false;
		const prior = this.#usageCache.getStale<UsageReport | null>(cacheKey)?.value;
		let merged = report;
		if (prior && Array.isArray(prior.limits)) {
			const headerLimitsById = new Map(report.limits.map(limit => [limit.id, limit]));
			const limits: UsageLimit[] = [];
			for (const limit of prior.limits) {
				const replacement = headerLimitsById.get(limit.id);
				if (replacement) {
					limits.push(replacement);
					headerLimitsById.delete(limit.id);
				} else {
					limits.push(limit);
				}
			}
			for (const limit of headerLimitsById.values()) {
				limits.push(limit);
			}
			merged = {
				...prior,
				fetchedAt: now,
				limits,
				metadata: {
					...(report.metadata ?? {}),
					...(prior.metadata ?? {}),
					headersUpdatedAt: now,
				},
			};
		}

		this.#usageCache.set(cacheKey, { value: merged, expiresAt: now + USAGE_REPORT_TTL_MS });
		this.#usageHeaderIngestAt.set(cacheKey, now);
		return true;
	}

	#collectUsageRequests(options?: {
		baseUrlResolver?: (provider: Provider) => string | undefined;
	}): UsageRequestDescriptor[] {
		const resolver = this.#usageProviderResolver;
		if (!resolver) return [];

		const requests: UsageRequestDescriptor[] = [];
		const providers = new Set<string>([
			...this.#data.keys(),
			...listRegisteredUsageProviders().map(provider => provider.id),
		]);

		for (const providerId of providers) {
			const provider = providerId as Provider;
			const providerImpl = resolver(provider);
			if (!providerImpl) continue;
			const baseUrl = options?.baseUrlResolver?.(provider);
			let entries = this.#getStoredCredentials(providerId);
			if (entries.length > 0) {
				const dedupedEntries = this.#pruneDuplicateStoredCredentials(providerId, entries);
				if (dedupedEntries.length !== entries.length) {
					this.#setStoredCredentials(providerId, dedupedEntries);
				}
				entries = dedupedEntries;
			}

			if (entries.length === 0) {
				const runtimeKey = this.#runtimeOverrides.get(providerId);
				const envKey = getEnvApiKey(providerId);
				const apiKey = runtimeKey ?? envKey;
				if (!apiKey) continue;
				const request = this.#buildUsageRequest(provider, { type: "api_key", apiKey }, baseUrl);
				if (providerImpl.supports && !providerImpl.supports(request)) continue;
				requests.push(request);
				continue;
			}

			for (const entry of entries) {
				const credential = entry.credential;
				const request =
					credential.type === "api_key"
						? this.#buildUsageRequest(provider, { type: "api_key", apiKey: credential.key }, baseUrl)
						: this.#buildUsageRequestForOauth(provider, credential, baseUrl);
				if (providerImpl.supports && !providerImpl.supports(request)) continue;
				requests.push(request);
			}
		}

		return requests;
	}

	#getUsageReportMetadataValue(report: UsageReport, key: string): string | undefined {
		const metadata = report.metadata;
		if (!metadata || typeof metadata !== "object") return undefined;
		const value = metadata[key];
		return typeof value === "string" ? value.trim() : undefined;
	}

	#getUsageReportScopeAccountId(report: UsageReport): string | undefined {
		const ids = new Set<string>();
		for (const limit of report.limits) {
			const accountId = limit.scope.accountId?.trim();
			if (accountId) ids.add(accountId);
		}
		if (ids.size === 1) return Array.from(ids)[0];
		return undefined;
	}

	#getUsageReportScopeProjectId(report: UsageReport): string | undefined {
		const ids = new Set<string>();
		for (const limit of report.limits) {
			const projectId = limit.scope.projectId?.trim();
			if (projectId) ids.add(projectId);
		}
		if (ids.size === 1) return Array.from(ids)[0];
		return undefined;
	}

	#getUsageReportIdentifiers(report: UsageReport): string[] {
		const identifiers: string[] = [];
		const email = this.#getUsageReportMetadataValue(report, "email");
		if (email) identifiers.push(`email:${email.toLowerCase()}`);
		if (report.provider === "anthropic") {
			if (identifiers.length === 0) {
				const accountId =
					this.#getUsageReportMetadataValue(report, "accountId") ?? this.#getUsageReportScopeAccountId(report);
				if (accountId) identifiers.push(`account:${accountId}`);
			}
			const orgId = this.#getUsageReportMetadataValue(report, "orgId");
			if (orgId) {
				if (identifiers.length === 0) return [`anthropic:org:${orgId.toLowerCase()}`];
				return identifiers.map(identifier => `anthropic:org:${orgId.toLowerCase()}|${identifier.toLowerCase()}`);
			}
			return identifiers.map(identifier => `anthropic:${identifier.toLowerCase()}`);
		}
		if (report.provider === "openai-codex") {
			return identifiers.map(identifier => `${report.provider}:${identifier.toLowerCase()}`);
		}
		const projectId =
			this.#getUsageReportMetadataValue(report, "projectId") ?? this.#getUsageReportScopeProjectId(report);
		if (projectId && !email) identifiers.push(`project:${projectId}`);
		const accountId = this.#getUsageReportMetadataValue(report, "accountId");
		if (accountId) identifiers.push(`account:${accountId}`);
		const account = this.#getUsageReportMetadataValue(report, "account");
		if (account) identifiers.push(`account:${account}`);
		const user = this.#getUsageReportMetadataValue(report, "user");
		if (user) identifiers.push(`account:${user}`);
		const username = this.#getUsageReportMetadataValue(report, "username");
		if (username) identifiers.push(`account:${username}`);
		const scopeAccountId = this.#getUsageReportScopeAccountId(report);
		if (scopeAccountId) identifiers.push(`account:${scopeAccountId}`);
		return identifiers.map(identifier => `${report.provider}:${identifier.toLowerCase()}`);
	}

	#mergeUsageReportGroup(reports: UsageReport[]): UsageReport {
		if (reports.length === 1) return reports[0];
		const sorted = reports.slice().sort((a, b) => {
			const limitDiff = b.limits.length - a.limits.length;
			if (limitDiff !== 0) return limitDiff;
			return (b.fetchedAt ?? 0) - (a.fetchedAt ?? 0);
		});
		const base = sorted[0];
		const mergedLimits = base.limits.slice();
		const limitIds = new Set(mergedLimits.map(limit => limit.id));
		const mergedMetadata: Record<string, unknown> = { ...(base.metadata ?? {}) };
		let fetchedAt = base.fetchedAt;

		for (const report of sorted.slice(1)) {
			fetchedAt = Math.max(fetchedAt, report.fetchedAt);
			for (const limit of report.limits) {
				if (!limitIds.has(limit.id)) {
					limitIds.add(limit.id);
					mergedLimits.push(limit);
				}
			}
			if (report.metadata) {
				for (const [key, value] of Object.entries(report.metadata)) {
					if (mergedMetadata[key] === undefined) {
						mergedMetadata[key] = value;
					}
				}
			}
		}

		return {
			...base,
			fetchedAt,
			limits: mergedLimits,
			metadata: Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined,
		};
	}

	#dedupeUsageReports(reports: UsageReport[]): UsageReport[] {
		const groups: UsageReport[][] = [];
		const idToGroup = new Map<string, number>();

		for (const report of reports) {
			const identifiers = this.#getUsageReportIdentifiers(report);
			let groupIndex: number | undefined;
			for (const identifier of identifiers) {
				const existing = idToGroup.get(identifier);
				if (existing !== undefined) {
					groupIndex = existing;
					break;
				}
			}
			if (groupIndex === undefined) {
				groupIndex = groups.length;
				groups.push([]);
			}
			groups[groupIndex].push(report);
			for (const identifier of identifiers) {
				idToGroup.set(identifier, groupIndex);
			}
		}

		const deduped = groups.map(group => this.#mergeUsageReportGroup(group));
		if (deduped.length !== reports.length) {
			this.#usageLogger?.debug("Usage reports deduped", {
				before: reports.length,
				after: deduped.length,
			});
		}
		return deduped;
	}

	#isUsageLimitExhausted(limit: UsageLimit): boolean {
		if (limit.status === "exhausted") return true;
		const amount = limit.amount;
		if (amount.usedFraction !== undefined && amount.usedFraction >= 1) return true;
		if (amount.remainingFraction !== undefined && amount.remainingFraction <= 0) return true;
		if (amount.used !== undefined && amount.limit !== undefined && amount.used >= amount.limit) return true;
		if (amount.remaining !== undefined && amount.remaining <= 0) return true;
		if (amount.unit === "percent" && amount.used !== undefined && amount.used >= 100) return true;
		return false;
	}

	#getScopedUsageLimits(
		strategy: CredentialRankingStrategy,
		report: UsageReport,
		context: CredentialRankingContext,
	): UsageLimit[] {
		return strategy.scopeLimits?.(report, context) ?? report.limits;
	}

	#isUsageLimitReached(limits: UsageLimit[]): boolean {
		return limits.some(limit => this.#isUsageLimitExhausted(limit));
	}

	#getUsageResetAtMs(limits: UsageLimit[], nowMs: number): number | undefined {
		const candidates: number[] = [];
		for (const limit of limits) {
			if (!this.#isUsageLimitExhausted(limit)) continue;
			const window = limit.window;
			if (window?.resetsAt && window.resetsAt > nowMs) {
				candidates.push(window.resetsAt);
			}
		}
		if (candidates.length === 0) return undefined;
		return Math.min(...candidates);
	}

	async #getUsageReport(
		provider: Provider,
		credential: AuthCredential,
		options?: { baseUrl?: string; timeoutMs?: number; signal?: AbortSignal },
	): Promise<UsageReport | null> {
		if (credential.type === "oauth") {
			const storeHook = this.#store.getUsageReport?.bind(this.#store);
			if (storeHook) {
				const report = await withAuthHttpConcurrency(() => storeHook(provider, credential, options?.signal));
				if (report) {
					this.#reconcileCodexUsageBlock(
						this.#buildUsageRequestForOauth(provider, credential, options?.baseUrl),
						report,
					);
				}
				return report;
			}
		}
		const usageCredential = this.#buildUsageCredential(credential);
		if (credential.type === "api_key") {
			const resolvedApiKey = await this.#configValueResolver(credential.key);
			if (!resolvedApiKey) return null;
			usageCredential.apiKey = resolvedApiKey;
		}
		return this.#fetchUsageCached(
			this.#buildUsageRequest(provider, usageCredential, options?.baseUrl),
			options?.timeoutMs ?? this.#usageRequestTimeoutMs,
		);
	}

	usageProviderFor(provider: Provider): UsageProvider | undefined {
		return this.#usageProviderResolver?.(provider);
	}

	async fetchUsageReports(options?: {
		baseUrlResolver?: (provider: Provider) => string | undefined;
		signal?: AbortSignal;
	}): Promise<UsageReport[] | null> {
		const storeOverride = this.#store.fetchUsageReports?.bind(this.#store);
		const override = this.#fetchUsageReportsOverride ?? storeOverride;
		const shouldReconcileStoreHookReports =
			this.#fetchUsageReportsOverride === undefined && storeOverride !== undefined;
		if (override) {
			const OVERRIDE_KEY = "__override__";
			let shared = this.#usageReportsInFlight.get(OVERRIDE_KEY);
			if (!shared) {
				shared = withAuthHttpConcurrency(override).finally(() => {
					this.#usageReportsInFlight.delete(OVERRIDE_KEY);
				});
				this.#usageReportsInFlight.set(OVERRIDE_KEY, shared);
			}
			const reports = await raceUsageWithSignal(shared, options?.signal);
			if (shouldReconcileStoreHookReports && reports) this.#reconcileCodexUsageBlocksFromReports(reports);
			return reports;
		}
		if (!this.#usageProviderResolver) return null;

		const requests = this.#collectUsageRequests(options);
		if (requests.length === 0) return [];

		this.#usageLogger?.debug("Usage fetch requested", {
			providers: Array.from(new Set(requests.map(request => request.provider))).sort(),
		});

		const cacheKey = this.#buildUsageReportsCacheKey(requests);

		const inFlight = this.#usageReportsInFlight.get(cacheKey);
		if (inFlight) return inFlight;

		const promise = (async () => {
			for (const request of requests) {
				this.#usageLogger?.debug("Usage fetch queued", {
					provider: request.provider,
					credentialType: request.credential.type,
					baseUrl: request.baseUrl,
					accountId: request.credential.accountId,
					email: request.credential.email,
				});
			}

			const results = await Promise.all(
				requests.map(request => this.#fetchUsageCached(request, this.#usageRequestTimeoutMs)),
			);
			const reports = results.filter((report): report is UsageReport => report !== null);
			const deduped = this.#dedupeUsageReports(reports);
			const resolved = deduped;
			this.#usageLogger?.debug("Usage fetch resolved", {
				reports: resolved.map(report => {
					const accountLabel =
						this.#getUsageReportMetadataValue(report, "email") ??
						this.#getUsageReportMetadataValue(report, "accountId") ??
						this.#getUsageReportMetadataValue(report, "account") ??
						this.#getUsageReportMetadataValue(report, "user") ??
						this.#getUsageReportMetadataValue(report, "username") ??
						this.#getUsageReportScopeAccountId(report);
					return {
						provider: report.provider,
						limits: report.limits.length,
						account: accountLabel,
					};
				}),
			});
			return resolved;
		})().finally(() => {
			this.#usageReportsInFlight.delete(cacheKey);
		});

		this.#usageReportsInFlight.set(cacheKey, promise);
		return promise;
	}

	async checkCredentials(options?: CheckCredentialsOptions): Promise<CredentialHealthResult[]> {
		options?.signal?.throwIfAborted();
		const active = this.#store.listAuthCredentials();
		const wanted = options?.credentialIds;
		const stored = wanted === undefined ? active : active.filter(row => wanted.includes(row.id));
		const resolver = this.#usageProviderResolver;
		const timeoutMs = options?.timeoutMs ?? this.#usageRequestTimeoutMs;
		const completionProbe = options?.completionProbe;
		const completionTimeoutMs = options?.completionTimeoutMs ?? timeoutMs;
		const ctx: UsageFetchContext = {
			fetch: this.#usageFetch,
			logger: this.#usageLogger,
			listUsageCosts: query => this.#store.listUsageCosts?.(query) ?? [],
		};

		const results: CredentialHealthResult[] = [];
		for (const row of stored) {
			options?.signal?.throwIfAborted();
			const base: CredentialHealthResult = {
				id: row.id,
				provider: row.provider,
				type: row.credential.type,
				ok: null,
			};
			if (row.credential.type === "oauth") {
				if (row.credential.email) base.email = row.credential.email;
				if (row.credential.accountId) base.accountId = row.credential.accountId;
				if (row.credential.orgId) base.orgId = row.credential.orgId;
				if (row.credential.orgName) base.orgName = row.credential.orgName;
				if (row.credential.refresh === REMOTE_REFRESH_SENTINEL) base.remoteRefresh = true;
			}

			const baseUrl = options?.baseUrlResolver?.(row.provider as Provider);
			const cred = row.credential;
			const initialRequest: UsageRequestDescriptor =
				cred.type === "api_key"
					? this.#buildUsageRequest(row.provider as Provider, { type: "api_key", apiKey: cred.key }, baseUrl)
					: this.#buildUsageRequestForOauth(row.provider as Provider, cred, baseUrl);

			const probeTimeout = scopedTimeoutSignal(timeoutMs, options?.signal);
			const probeSignal = probeTimeout.signal;
			let params: UsageFetchParams & { signal: AbortSignal } = {
				...initialRequest,
				accountKey: this.#buildUsageCacheIdentity(initialRequest.credential),
				signal: probeSignal,
			};
			let refreshError: string | undefined;

			if (
				cred.type === "oauth" &&
				initialRequest.credential.type === "oauth" &&
				initialRequest.credential.expiresAt !== undefined &&
				Date.now() >= initialRequest.credential.expiresAt
			) {
				const refreshable = this.#buildRefreshableOauthCredential(initialRequest.credential);
				if (refreshable) {
					try {
						const refreshed = await this.#refreshOAuthCredential(
							row.provider as Provider,
							refreshable,
							row.id,
							probeSignal,
						);
						const refreshedCredential = this.#mergeRefreshedUsageCredential(initialRequest.credential, refreshed);
						this.#persistRefreshedUsageCredential(
							row.provider as Provider,
							initialRequest.credential,
							refreshedCredential,
						);
						params = {
							...params,
							credential: refreshedCredential,
							accountKey: this.#buildUsageCacheIdentity(refreshedCredential),
						};
					} catch (error) {
						refreshError = `oauth refresh failed: ${errorMessage(error)}`;
					}
				}
			}

			if (refreshError) {
				probeTimeout.cancel();
				base.ok = false;
				base.reason = refreshError;
				this.#authDeadCredentials.add(row.id);
				results.push(base);
				continue;
			}

			const providerImpl = resolver?.(row.provider as Provider);
			if (!providerImpl) {
				base.reason = `no usage probe configured for provider ${row.provider}`;
			} else if (providerImpl.supports && !providerImpl.supports(initialRequest)) {
				base.reason = `usage probe does not support ${cred.type} credentials for ${row.provider}`;
			} else if (providerImpl.validatesCredentials === false) {
				base.reason = `usage probe for ${row.provider} does not validate credentials`;
			} else {
				try {
					const report = await providerImpl.fetchUsage(params, ctx);
					if (report === null) {
						base.reason = "usage probe returned no data for this credential";
					} else {
						base.ok = true;
						const accountId = this.#getUsageReportMetadataValue(report, "accountId");
						const email = this.#getUsageReportMetadataValue(report, "email");
						if (accountId) base.accountId = accountId;
						if (email) base.email = email;
						const { raw: _raw, ...trimmed } = report;
						base.report = trimmed;
					}
				} catch (error) {
					base.ok = false;
					base.reason = errorMessage(error);
				}
			}
			probeTimeout.cancel();

			if (completionProbe) {
				const probeCred = this.#buildCompletionProbeCredential(params.credential);
				if (!probeCred) {
					base.completion = {
						ok: null,
						reason: `no bearer bytes available for ${row.credential.type} credential`,
					};
				} else {
					const completionTimeout = scopedTimeoutSignal(completionTimeoutMs, options?.signal);
					try {
						base.completion = await completionProbe({
							provider: row.provider as Provider,
							credentialId: row.id,
							credential: probeCred,
							signal: completionTimeout.signal,
						});
					} catch (error) {
						base.completion = {
							ok: false,
							reason: errorMessage(error),
						};
					} finally {
						completionTimeout.cancel();
					}
				}
			}

			results.push(base);
		}

		return results;
	}

	async #resolveCredentialTarget(
		provider: string,
		sessionId: string | undefined,
		options?: { credentialId?: number; apiKey?: string },
	): Promise<{ type: AuthCredential["type"]; index: number; explicit: boolean } | undefined> {
		const explicit = options?.credentialId !== undefined || options?.apiKey !== undefined;
		if (explicit) {
			const latestRows = this.#store.listAuthCredentials(provider);
			this.#setStoredCredentials(
				provider,
				latestRows.map(row => ({ id: row.id, credential: row.credential })),
			);
		}
		if (options?.credentialId !== undefined) {
			const stored = this.#getStoredCredentials(provider);
			const index = stored.findIndex(entry => entry.id === options.credentialId);
			const entry = index === -1 ? undefined : stored[index];
			if (entry) return { type: entry.credential.type, index, explicit: true };
		}
		if (options?.apiKey !== undefined) {
			const stored = this.#getStoredCredentials(provider);
			for (let index = 0; index < stored.length; index++) {
				const entry = stored[index];
				if (entry && (await this.#credentialMatchesApiKey(entry.credential, options.apiKey))) {
					return { type: entry.credential.type, index, explicit: true };
				}
			}
		}
		if (explicit) return undefined;
		const sessionCredential = this.#getSessionCredential(provider, sessionId);
		return sessionCredential ? { ...sessionCredential, explicit: false } : undefined;
	}

	async markUsageLimitReached(
		provider: string,
		sessionId: string | undefined,
		options?: {
			retryAfterMs?: number;
			baseUrl?: string;
			modelId?: string;
			apiKey?: string;
			credentialId?: number;
			signal?: AbortSignal;
		},
	): Promise<UsageLimitMarkResult> {
		let sessionCredential = await this.#resolveCredentialTarget(provider, sessionId, {
			credentialId: options?.credentialId,
			apiKey: options?.apiKey,
		});
		if (!sessionCredential && options?.credentialId === undefined && options?.apiKey !== undefined) {
			const credentialId = this.#findOAuthCredentialIdForBearer(provider, options.apiKey);
			const index =
				credentialId === undefined
					? -1
					: this.#getStoredCredentials(provider).findIndex(
							entry => entry.id === credentialId && entry.credential.type === "oauth",
						);
			if (index >= 0) sessionCredential = { type: "oauth", index, explicit: true };
		}
		if (!sessionCredential) return { switched: false };
		const target = this.#getStoredCredentials(provider)[sessionCredential.index];
		if (!target || target.credential.type !== sessionCredential.type) return { switched: false };
		const credentialType = sessionCredential.type;
		const targetCredentialId = target.id;

		const providerKey = this.#getProviderTypeKey(provider, credentialType);
		const strategy = this.#rankingStrategyResolver?.(provider);
		const rankingContext: CredentialRankingContext = { modelId: options?.modelId };
		const blockScope = strategy?.blockScope?.(rankingContext);
		const now = Date.now();
		let blockedUntil = now + (options?.retryAfterMs ?? AuthStorage.#defaultBackoffMs);

		if (credentialType === "oauth" && target.credential.type === "oauth" && strategy) {
			const report = await this.#getUsageReport(provider, target.credential, options);
			if (report) {
				const scopedLimits = this.#getScopedUsageLimits(strategy, report, rankingContext);
				if (this.#isUsageLimitReached(scopedLimits)) {
					const resetAtMs = this.#getUsageResetAtMs(scopedLimits, Date.now());
					if (resetAtMs && resetAtMs > blockedUntil) {
						blockedUntil = resetAtMs;
					}
				}
			}
		}

		const targetIndex = this.#getStoredCredentials(provider).findIndex(
			entry => entry.id === targetCredentialId && entry.credential.type === credentialType,
		);
		if (targetIndex >= 0) {
			this.#markCredentialBlocked(provider, providerKey, targetIndex, blockedUntil, blockScope);
		}

		const siblings = this.#getCredentialsForProvider(provider)
			.map((credential, index) => ({ credential, index }))
			.filter(
				(entry): entry is { credential: AuthCredential; index: number } =>
					entry.credential.type === credentialType && entry.index !== targetIndex,
			);
		const siblingBlockedUntil = (index: number): number | undefined =>
			this.#getCredentialBlockedUntil(provider, providerKey, index, blockScope);

		if (!this.#loadBalancingEnabled()) {
			const idleSiblings = siblings.filter(candidate => siblingBlockedUntil(candidate.index) === undefined).length;
			if (idleSiblings > 0) {
				const noticeKey = `${provider}:${targetCredentialId}:${blockedUntil}`;
				if (!this.#withheldQuotaNotices.has(noticeKey)) {
					if (this.#withheldQuotaNotices.size >= MAX_WITHHELD_QUOTA_NOTICES) this.#withheldQuotaNotices.clear();
					this.#withheldQuotaNotices.add(noticeKey);
					this.#emitUsageLimitWithheld({
						provider,
						account: {
							credentialId: targetCredentialId,
							label: this.#accountNoticeLabel(provider, targetCredentialId),
						},
						idleSiblings,
						retryAtMs: blockedUntil,
					});
				}
			}
			return { switched: false, retryAtMs: blockedUntil };
		}

		let retryAtMs: number | undefined;
		for (const candidate of siblings) {
			const candidateBlockedUntil = siblingBlockedUntil(candidate.index);
			if (candidateBlockedUntil === undefined) return { switched: true };
			if (retryAtMs === undefined || candidateBlockedUntil < retryAtMs) retryAtMs = candidateBlockedUntil;
		}
		return { switched: false, retryAtMs };
	}

	#resolveWindowResetAt(window: UsageLimit["window"]): number | undefined {
		if (!window) return undefined;
		if (typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)) {
			return window.resetsAt;
		}
		return undefined;
	}

	#normalizeUsageFraction(limit: UsageLimit | undefined): number {
		const usedFraction = limit?.amount.usedFraction;
		if (typeof usedFraction !== "number" || !Number.isFinite(usedFraction)) {
			return 0.5;
		}
		return clamp01(usedFraction);
	}

	#computeWindowRequiredDrain(limit: UsageLimit | undefined, nowMs: number, fallbackDurationMs: number): number {
		const headroom = 1 - this.#normalizeUsageFraction(limit);
		if (headroom <= 0) return 0;
		const resetAt = this.#resolveWindowResetAt(limit?.window);
		if (resetAt === undefined) return headroom;
		const durationMs = limit?.window?.durationMs ?? fallbackDurationMs;
		let remainingMs = resetAt - nowMs;
		if (Number.isFinite(durationMs) && durationMs > 0) {
			remainingMs = Math.min(remainingMs, durationMs);
		}
		const remainingHours = Math.max(remainingMs, 60_000) / (60 * 60 * 1000);
		return headroom / remainingHours;
	}

	#compareUsageRankedCandidatePriority(
		left: UsageRankedCandidate<AuthCredential>,
		right: UsageRankedCandidate<AuthCredential>,
		planRequirement: OpenAICodexPlanRequirement,
	): number {
		if (left.blocked !== right.blocked) return left.blocked ? 1 : -1;
		if (left.blocked && right.blocked) {
			const leftBlockedUntil = left.blockedUntil ?? Number.POSITIVE_INFINITY;
			const rightBlockedUntil = right.blockedUntil ?? Number.POSITIVE_INFINITY;
			if (leftBlockedUntil !== rightBlockedUntil) return leftBlockedUntil - rightBlockedUntil;
			return 0;
		}
		if (planRequirement !== "none" && left.planPriority !== right.planPriority) {
			return left.planPriority - right.planPriority;
		}
		if (left.hasPriorityBoost !== right.hasPriorityBoost) return left.hasPriorityBoost ? -1 : 1;
		const leftHot = left.primaryUsed >= PRIMARY_WINDOW_HOT_FRACTION;
		const rightHot = right.primaryUsed >= PRIMARY_WINDOW_HOT_FRACTION;
		if (leftHot !== rightHot) return leftHot ? 1 : -1;
		const leftMeasured = left.usage !== null;
		const rightMeasured = right.usage !== null;
		if (leftMeasured !== rightMeasured) return leftMeasured ? -1 : 1;
		let metric = compareUsageRankingMetric(right.secondaryRequiredDrain, left.secondaryRequiredDrain);
		if (metric !== 0) return metric;
		metric = compareUsageRankingMetric(left.secondaryUsed, right.secondaryUsed);
		if (metric !== 0) return metric;
		metric = compareUsageRankingMetric(right.primaryRequiredDrain, left.primaryRequiredDrain);
		if (metric !== 0) return metric;
		metric = compareUsageRankingMetric(left.primaryUsed, right.primaryUsed);
		if (metric !== 0) return metric;
		return 0;
	}

	#compareUsageRankedCandidates(
		left: UsageRankedCandidate<AuthCredential>,
		right: UsageRankedCandidate<AuthCredential>,
		planRequirement: OpenAICodexPlanRequirement,
	): number {
		const priority = this.#compareUsageRankedCandidatePriority(left, right, planRequirement);
		return priority !== 0 ? priority : left.orderPos - right.orderPos;
	}

	#orderUsageRankedCandidates<T extends AuthCredential>(
		candidates: UsageRankedCandidate<T>[],
		planRequirement: OpenAICodexPlanRequirement,
	): UsageCandidate<T>[] {
		candidates.sort((left, right) => this.#compareUsageRankedCandidates(left, right, planRequirement));
		return candidates.map(candidate => ({
			selection: candidate.selection,
			usage: candidate.usage,
			usageChecked: candidate.usageChecked,
		}));
	}

	async #rankOAuthSelections(args: {
		providerKey: string;
		provider: string;
		order: number[];
		planRequirement: OpenAICodexPlanRequirement;
		credentials: OAuthSelection[];
		options?: AuthApiKeyOptions;
		strategy: CredentialRankingStrategy;
		rankingContext: CredentialRankingContext;
		blockScope?: string;
	}): Promise<OAuthCandidate[]> {
		const nowMs = Date.now();
		const { strategy } = args;
		const ranked: RankedOAuthCandidate[] = [];
		const usageTimeout = Math.max(5000, this.#usageRequestTimeoutMs * 1.5);
		const usagePromise = Promise.all(
			args.order.map(async idx => {
				const selection = args.credentials[idx];
				if (!selection) return null;
				let blockedUntil = this.#getCredentialBlockedUntil(
					args.provider,
					args.providerKey,
					selection.index,
					args.blockScope,
				);
				let usage: UsageReport | null = null;
				let usageChecked = false;
				if (blockedUntil !== undefined && args.provider === "openai-codex") {
					usage = await this.#getUsageReport(args.provider, selection.credential, {
						...args.options,
						timeoutMs: this.#usageRequestTimeoutMs,
					});
					usageChecked = true;
					blockedUntil = this.#getCredentialBlockedUntil(
						args.provider,
						args.providerKey,
						selection.index,
						args.blockScope,
					);
				}
				if (blockedUntil !== undefined) return { selection, usage, usageChecked, blockedUntil };
				if (!usageChecked) {
					usage = await this.#getUsageReport(args.provider, selection.credential, {
						...args.options,
						timeoutMs: this.#usageRequestTimeoutMs,
					});
					usageChecked = true;
				}
				return { selection, usage, usageChecked, blockedUntil: undefined as number | undefined };
			}),
		);
		const timeoutSignal = Promise.withResolvers<null>();
		const timer = setTimeout(() => timeoutSignal.resolve(null), usageTimeout);
		timer.unref?.();
		const usageResults = await Promise.race([usagePromise, timeoutSignal.promise]).then(result => {
			clearTimeout(timer);
			return (
				result ??
				args.order.map(idx => {
					const selection = args.credentials[idx];
					return selection ? { selection, usage: null, usageChecked: false, blockedUntil: undefined } : null;
				})
			);
		});

		for (let orderPos = 0; orderPos < usageResults.length; orderPos += 1) {
			const result = usageResults[orderPos];
			if (!result) continue;
			const { selection, usage, usageChecked } = result;
			let { blockedUntil } = result;
			let blocked = blockedUntil !== undefined;
			const scopedLimits = usage ? this.#getScopedUsageLimits(strategy, usage, args.rankingContext) : undefined;
			if (!blocked && scopedLimits && this.#isUsageLimitReached(scopedLimits)) {
				const resetAtMs = this.#getUsageResetAtMs(scopedLimits, nowMs);
				blockedUntil = resetAtMs ?? Date.now() + AuthStorage.#defaultBackoffMs;
				this.#markCredentialBlocked(
					args.provider,
					args.providerKey,
					selection.index,
					blockedUntil,
					args.blockScope,
				);
				blocked = true;
			}
			const windows = usage ? strategy.findWindowLimits(usage, args.rankingContext) : undefined;
			const primary = windows?.primary;
			const secondary = windows?.secondary;
			const secondaryTarget = secondary ?? primary;
			ranked.push({
				selection,
				usage,
				usageChecked,
				blocked,
				blockedUntil,
				hasPriorityBoost: strategy.hasPriorityBoost?.(primary) ?? false,
				planPriority: getOpenAICodexPlanPriority(usage, args.planRequirement),
				secondaryUsed: this.#normalizeUsageFraction(secondaryTarget),
				secondaryRequiredDrain: this.#computeWindowRequiredDrain(
					secondaryTarget,
					nowMs,
					strategy.windowDefaults.secondaryMs,
				),
				primaryUsed: this.#normalizeUsageFraction(primary),
				primaryRequiredDrain: this.#computeWindowRequiredDrain(primary, nowMs, strategy.windowDefaults.primaryMs),
				orderPos,
			});
		}
		return this.#orderUsageRankedCandidates(ranked, args.planRequirement);
	}

	async #resolveOAuthSelection(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
	): Promise<OAuthResolutionResult | undefined> {
		const credentials = this.#getCredentialsForProvider(provider)
			.map((credential, index) => ({ credential, index }))
			.filter((entry): entry is { credential: OAuthCredential; index: number } => entry.credential.type === "oauth");

		if (credentials.length === 0) return undefined;

		const providerKey = this.#getProviderTypeKey(provider, "oauth");
		const order = this.#getCredentialOrder(providerKey, sessionId, credentials.length);
		const strategy = this.#rankingStrategyResolver?.(provider);
		const rankingContext: CredentialRankingContext = { modelId: options?.modelId };
		const blockScope = strategy?.blockScope?.(rankingContext);
		const planRequirement = resolveOpenAICodexPlanRequirement(provider, options?.modelId);
		const hasPlanRequirement = planRequirement !== "none";
		const checkUsage = strategy !== undefined && (credentials.length > 1 || hasPlanRequirement);
		const sessionCredential = this.#getSessionCredential(provider, sessionId);
		const sessionPreferredIndex = sessionCredential?.type === "oauth" ? sessionCredential.index : undefined;
		const sessionPreferredCredential =
			sessionPreferredIndex !== undefined
				? credentials.find(entry => entry.index === sessionPreferredIndex)?.credential
				: undefined;
		const sessionPreferredCanRefreshOrUse =
			sessionPreferredCredential !== undefined &&
			(sessionPreferredCredential.refresh.trim().length > 0 ||
				Date.now() + OAUTH_REFRESH_SKEW_MS < sessionPreferredCredential.expires);
		const sessionPreferredIsAvailable =
			sessionPreferredIndex !== undefined &&
			sessionPreferredCanRefreshOrUse &&
			!this.#isCredentialBlocked(provider, providerKey, sessionPreferredIndex, blockScope);
		const chosenIndex = this.#explicitChoiceIndex(provider, sessionId, "oauth");
		const shouldRank = checkUsage && (!sessionPreferredIsAvailable || hasPlanRequirement);
		const rankingOrder = shouldRank && sessionId ? credentials.map((_credential, index) => index) : order;
		const candidates = shouldRank
			? await this.#rankOAuthSelections({
					providerKey,
					provider,
					planRequirement,
					order: rankingOrder,
					credentials,
					options,
					strategy: strategy!,
					rankingContext,
					blockScope,
				})
			: // The unranked path (no ranking strategy, or a session that already
				this.#orderByBlockAvailability(
					provider,
					providerKey,
					order.map(idx => credentials[idx]),
					blockScope,
				).map(selection => ({ selection, usage: null, usageChecked: false }));

		const leadIndex = hasPlanRequirement ? undefined : (chosenIndex ?? sessionPreferredIndex);
		if (leadIndex !== undefined) {
			const leadCandidate = candidates.findIndex(
				candidate =>
					candidate.selection.index === leadIndex &&
					(candidate.selection.index === chosenIndex ||
						!this.#isCredentialBlocked(provider, providerKey, candidate.selection.index, blockScope)),
			);
			if (leadCandidate > 0) {
				const [lead] = candidates.splice(leadCandidate, 1);
				candidates.unshift(lead);
			}
		}
		const forceRefreshIndex = options?.forceRefresh
			? (sessionPreferredIndex ?? candidates[0]?.selection.index)
			: undefined;
		const preflightDefinitiveErrors = new WeakMap<object, unknown>();
		await Promise.all(
			candidates.map(async candidate => {
				const force = forceRefreshIndex !== undefined && candidate.selection.index === forceRefreshIndex;
				const initialCredentialId = this.#getStoredCredentials(provider)[candidate.selection.index]?.id;
				let syncedPeerCredential = false;
				if (initialCredentialId !== undefined) {
					const beforeSync = candidate.selection.credential;
					if (!this.#syncOAuthSelectionFromStore(provider, candidate.selection, initialCredentialId)) return;
					syncedPeerCredential = !authCredentialEquals(beforeSync, candidate.selection.credential);
				}
				const hasFreshAccess = Date.now() + OAUTH_REFRESH_SKEW_MS < candidate.selection.credential.expires;
				if ((!force || syncedPeerCredential) && hasFreshAccess) return;
				const latestCredential = this.#getCredentialsForProvider(provider)[candidate.selection.index];
				if (
					!force &&
					latestCredential?.type === "oauth" &&
					Date.now() + OAUTH_REFRESH_SKEW_MS < latestCredential.expires
				) {
					candidate.selection.credential = latestCredential;
					return;
				}
				try {
					const credentialId = this.#getStoredCredentials(provider)[candidate.selection.index]?.id;
					const refreshTarget = force
						? { ...candidate.selection.credential, expires: 0 }
						: candidate.selection.credential;
					const refreshedCredentials = await this.#refreshOAuthCredential(
						provider,
						refreshTarget,
						credentialId,
						options?.signal,
					);
					const updated: OAuthCredential = {
						...candidate.selection.credential,
						...refreshedCredentials,
						type: "oauth",
					};
					candidate.selection.credential = updated;
					if (credentialId !== undefined) {
						const idx = this.#persistRefreshedCredentialById(provider, credentialId, updated);
						if (idx !== -1) candidate.selection.index = idx;
					} else {
						this.#replaceCredentialAt(provider, candidate.selection.index, updated);
					}
				} catch (error) {
					logger.debug("OAuth preflight refresh failed", {
						provider,
						index: candidate.selection.index,
						error: String(error),
					});
					if (AIError.isDefinitiveOAuthFailure(String(error))) {
						preflightDefinitiveErrors.set(candidate, error);
					}
				}
			}),
		);

		const enforcePlanRequirement =
			hasPlanRequirement &&
			candidates.some(candidate => getOpenAICodexPlanEligibility(candidate.usage, planRequirement) === true);

		const passes: Array<{ allowBlocked: boolean; enforcePlanRequirement: boolean }> = [
			{ allowBlocked: false, enforcePlanRequirement },
			{ allowBlocked: true, enforcePlanRequirement },
		];
		if (enforcePlanRequirement) passes.push({ allowBlocked: true, enforcePlanRequirement: false });

		for (const pass of passes) {
			for (const candidate of candidates) {
				const resolved = await this.#tryOAuthCredential(
					provider,
					candidate.selection,
					providerKey,
					sessionId,
					options,
					{
						checkUsage,
						allowBlocked: pass.allowBlocked || candidate.selection.index === chosenIndex,
						prefetchedUsage: candidate.usage,
						usagePrechecked: candidate.usageChecked,
						planRequirement,
						enforcePlanRequirement: pass.enforcePlanRequirement,
						strategy,
						rankingContext,
						blockScope,
						preflightDefinitiveError: preflightDefinitiveErrors.get(candidate),
					},
				);
				if (resolved) return resolved;
			}
		}

		return undefined;
	}

	#storeSupportsDurableLease(): boolean {
		return (
			!!this.#store.tryAcquireCredentialRefreshLease &&
			!!this.#store.getCredentialRefreshLeaseExpiresAt &&
			!!this.#store.releaseCredentialRefreshLease &&
			!!this.#store.renewCredentialRefreshLease
		);
	}

	async #withRefreshLeaseRenewal<T>(
		credentialId: number | undefined,
		owner: string,
		fn: () => Promise<T>,
	): Promise<{ result: T; ownershipLost: unknown }> {
		if (credentialId === undefined) return { result: await fn(), ownershipLost: undefined };
		let stop = false;
		let ownershipLost: unknown;
		const stopped = Promise.withResolvers<void>();
		const renewal = (async () => {
			while (!stop) {
				await Promise.race([Bun.sleep(OAUTH_REFRESH_LEASE_RENEW_MS), stopped.promise]);
				if (stop) return;
				const renewed = this.#store.renewCredentialRefreshLease?.(
					credentialId,
					owner,
					Date.now() + OAUTH_REFRESH_LEASE_TTL_MS,
				);
				if (!renewed) {
					ownershipLost = new AIError.ConfigurationError("OAuth refresh ownership was lost before persistence");
					return;
				}
			}
		})().catch(error => {
			ownershipLost = error;
		});

		let result: T;
		try {
			result = await fn();
		} catch (error) {
			stop = true;
			stopped.resolve();
			await renewal;
			if (ownershipLost !== undefined) {
				logger.warn("OAuth refresh lost its lease while already failing", {
					credentialId,
					owner,
					ownershipError: String(ownershipLost),
				});
			}
			throw error;
		}
		stop = true;
		stopped.resolve();
		await renewal;
		return { result, ownershipLost };
	}

	#freshRotatedCredential(
		provider: Provider,
		credentialId: number,
		previous: OAuthCredential,
	): OAuthCredentials | undefined {
		const readById = this.#store.readAuthCredentialById?.bind(this.#store);
		if (!readById) return undefined;
		const latest = readById(credentialId);
		if (latest?.credential.type !== "oauth") return undefined;
		if (latest.provider !== provider) {
			logger.warn("OAuth credential row changed provider mid-refresh; refusing the peer's token", {
				credentialId,
				expectedProvider: provider,
				storedProvider: latest.provider,
			});
			return undefined;
		}
		const rotated = latest.credential;
		if (rotated.refresh === previous.refresh) return undefined;
		if (Date.now() + OAUTH_REFRESH_SKEW_MS >= rotated.expires) return undefined;
		return rotated;
	}

	#commitRotatedOAuthCredential(
		provider: Provider,
		credentialId: number,
		previous: OAuthCredential,
		refreshed: OAuthCredentials,
	): void {
		// Avoid overwriting newer rotation from peer.
		const peerFresh = this.#freshRotatedCredential(provider, credentialId, previous);
		if (peerFresh && peerFresh.refresh !== refreshed.refresh) return;

		const merged: OAuthCredential = { ...previous, ...refreshed, type: "oauth" };
		this.#persistRefreshedCredentialById(provider, credentialId, merged);
	}

	async #leaseFencedRefresh(
		provider: Provider,
		credential: OAuthCredential,
		credentialId: number,
		signal?: AbortSignal,
	): Promise<OAuthCredentials> {
		if (!this.#storeSupportsDurableLease()) {
			return this.#refreshOAuthCredentialUnshared(provider, credential, credentialId);
		}

		const owner = crypto.randomUUID();
		for (;;) {
			if (signal?.aborted) throw new AIError.RequestAbortError("OAuth refresh ownership aborted by caller");
			// A peer may have finished while we waited; prefer its token over spending ours.
			const peerFresh = this.#freshRotatedCredential(provider, credentialId, credential);
			if (peerFresh) return peerFresh;
			if (
				this.#store.tryAcquireCredentialRefreshLease?.(credentialId, owner, Date.now() + OAUTH_REFRESH_LEASE_TTL_MS)
			) {
				break;
			}
			const leaseExpiresAt = this.#store.getCredentialRefreshLeaseExpiresAt?.(credentialId);
			const waitMs =
				leaseExpiresAt === undefined
					? OAUTH_REFRESH_LEASE_POLL_MS
					: clamp(leaseExpiresAt - Date.now(), OAUTH_REFRESH_LEASE_POLL_MS, 250);
			await raceCredentialRefreshWithSignal(
				Bun.sleep(waitMs),
				signal,
				"OAuth refresh ownership wait aborted by caller",
			);
		}

		try {
			const peerFresh = this.#freshRotatedCredential(provider, credentialId, credential);
			if (peerFresh) return peerFresh;

			const { result: refreshed, ownershipLost } = await this.#withRefreshLeaseRenewal(credentialId, owner, () =>
				this.#refreshOAuthCredentialUnshared(provider, credential, credentialId),
			);

			if (ownershipLost !== undefined) {
				logger.warn("OAuth refresh lease lost mid-rotation; reconciling against the stored row", {
					provider,
					credentialId,
				});
				this.#commitRotatedOAuthCredential(provider, credentialId, credential, refreshed);
				const winner = this.#freshRotatedCredential(provider, credentialId, credential);
				if (winner) return winner;
			}
			return refreshed;
		} finally {
			this.#store.releaseCredentialRefreshLease?.(credentialId, owner);
		}
	}

	async #refreshOAuthCredential(
		provider: Provider,
		credential: OAuthCredential,
		credentialId: number | undefined,
		signal?: AbortSignal,
	): Promise<OAuthCredentials> {
		if (credentialId !== undefined) {
			const existing = this.#oauthCredentialRefreshInFlight.get(credentialId);
			if (existing) return raceCredentialRefreshWithSignal(existing, signal);
		}
		if (Date.now() + OAUTH_REFRESH_SKEW_MS < credential.expires) return credential;
		if (credentialId === undefined) {
			return this.#refreshOAuthCredentialUnshared(provider, credential, undefined, signal);
		}
		const id = credentialId;
		const promise = this.#leaseFencedRefresh(provider, credential, id, signal)
			.then(refreshed => {
				if (signal?.aborted) {
					this.#commitRotatedOAuthCredential(provider, id, credential, refreshed);
				}
				return refreshed;
			})
			.finally(() => {
				this.#oauthCredentialRefreshInFlight.delete(id);
			});
		this.#oauthCredentialRefreshInFlight.set(id, promise);
		return raceCredentialRefreshWithSignal(promise, signal);
	}

	async #refreshOAuthCredentialUnshared(
		provider: Provider,
		credential: OAuthCredential,
		credentialId: number | undefined,
		signal?: AbortSignal,
	): Promise<OAuthCredentials> {
		let refreshPromise: Promise<OAuthCredentials>;
		const storeRefresh = this.#store.refreshOAuthCredential?.bind(this.#store);
		const overrideRefresh = this.#refreshOAuthCredentialOverride ?? storeRefresh;
		if (overrideRefresh && credentialId !== undefined) {
			refreshPromise = overrideRefresh(provider, credentialId, credential, signal);
		} else {
			const customProvider = getOAuthProvider(provider);
			if (customProvider) {
				if (!customProvider.refreshToken) {
					throw new AIError.OAuthError(`OAuth provider "${provider}" does not support token refresh`, {
						kind: "configuration",
						provider,
					});
				}
				refreshPromise = customProvider.refreshToken(credential);
			} else {
				refreshPromise = refreshOAuthToken(provider as OAuthProvider, credential);
			}
		}
		let timeout: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;
		const cancellation = Promise.withResolvers<never>();
		timeout = setTimeout(
			() =>
				cancellation.reject(
					new AIError.OAuthError(`OAuth token refresh timed out for provider: ${provider}`, {
						kind: "timeout",
						provider,
					}),
				),
			DEFAULT_OAUTH_REFRESH_TIMEOUT_MS,
		);
		if (signal) {
			if (signal.aborted) {
				cancellation.reject(new AIError.RequestAbortError("OAuth token refresh aborted by caller"));
			} else {
				onAbort = () => cancellation.reject(new AIError.RequestAbortError("OAuth token refresh aborted by caller"));
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}
		try {
			return await Promise.race([refreshPromise, cancellation.promise]);
		} finally {
			if (timeout) clearTimeout(timeout);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		}
	}

	#syncOAuthSelectionFromStore(
		provider: string,
		selection: { credential: OAuthCredential; index: number },
		credentialId: number,
	): boolean {
		const latestRows = this.#store.listAuthCredentials(provider);
		this.#setStoredCredentials(
			provider,
			latestRows.map(row => ({ id: row.id, credential: row.credential })),
		);
		const latestIndex = latestRows.findIndex(row => row.id === credentialId);
		if (latestIndex === -1) return false;
		const latest = latestRows[latestIndex];
		if (latest?.credential.type !== "oauth") return false;
		selection.index = latestIndex;
		selection.credential = latest.credential;
		return true;
	}

	async #prepareOAuthCredentialForRequest(
		provider: string,
		selection: { credential: OAuthCredential; index: number },
		options: AuthApiKeyOptions | undefined,
	): Promise<boolean> {
		const stored = this.#getStoredCredentials(provider);
		const selected = stored[selection.index];
		if (selected?.credential.type !== "oauth") return false;

		const prepare = this.#store.prepareForRequest?.bind(this.#store);
		if (prepare) {
			await prepare(selected.id, { signal: options?.signal });
		}
		return this.#syncOAuthSelectionFromStore(provider, selection, selected.id);
	}

	async #tryOAuthCredential(
		provider: Provider,
		selection: { credential: OAuthCredential; index: number },
		providerKey: string,
		sessionId: string | undefined,
		options: AuthApiKeyOptions | undefined,
		usageOptions: {
			checkUsage: boolean;
			allowBlocked: boolean;
			prefetchedUsage?: UsageReport | null;
			usagePrechecked?: boolean;
			planRequirement?: OpenAICodexPlanRequirement;
			enforcePlanRequirement?: boolean;
			strategy?: CredentialRankingStrategy;
			rankingContext?: CredentialRankingContext;
			blockScope?: string;
			allowFallback?: boolean;
			preflightDefinitiveError?: unknown;
		},
	): Promise<OAuthResolutionResult | undefined> {
		const {
			checkUsage,
			allowBlocked,
			prefetchedUsage = null,
			usagePrechecked = false,
			planRequirement: providedPlanRequirement,
			enforcePlanRequirement,
			strategy,
			rankingContext,
			blockScope,
			allowFallback = true,
			preflightDefinitiveError,
		} = usageOptions;
		if (!allowBlocked && this.#isCredentialBlocked(provider, providerKey, selection.index, blockScope)) {
			return undefined;
		}

		if (!(await this.#prepareOAuthCredentialForRequest(provider, selection, options))) {
			return undefined;
		}
		const credentialId = this.#getStoredCredentials(provider)[selection.index]?.id;

		const planRequirement = providedPlanRequirement ?? resolveOpenAICodexPlanRequirement(provider, options?.modelId);
		const hasPlanRequirement = planRequirement !== "none";
		const applyPlanFilter = enforcePlanRequirement ?? hasPlanRequirement;
		let usage: UsageReport | null = null;
		let usageChecked = false;

		if ((checkUsage && !allowBlocked) || hasPlanRequirement) {
			if (usagePrechecked) {
				usage = prefetchedUsage;
				usageChecked = true;
			} else {
				usage = await this.#getUsageReport(provider, selection.credential, {
					...options,
					timeoutMs: this.#usageRequestTimeoutMs,
				});
				usageChecked = true;
			}
			if (applyPlanFilter && getOpenAICodexPlanEligibility(usage, planRequirement) !== true) {
				return undefined;
			}
			if (checkUsage && !allowBlocked && usage && strategy && rankingContext) {
				const scopedLimits = this.#getScopedUsageLimits(strategy, usage, rankingContext);
				if (this.#isUsageLimitReached(scopedLimits)) {
					const resetAtMs = this.#getUsageResetAtMs(scopedLimits, Date.now());
					this.#markCredentialBlocked(
						provider,
						providerKey,
						selection.index,
						resetAtMs ?? Date.now() + AuthStorage.#defaultBackoffMs,
						blockScope,
					);
					return undefined;
				}
			}
		}

		try {
			if (preflightDefinitiveError !== undefined) throw preflightDefinitiveError;
			let result: { newCredentials: OAuthCredentials; apiKey: string } | null;
			const customProvider = getOAuthProvider(provider);
			if (customProvider) {
				const refreshedCredentials = await this.#refreshOAuthCredential(
					provider,
					selection.credential,
					credentialId,
					options?.signal,
				);
				const apiKey = customProvider.getApiKey
					? customProvider.getApiKey(refreshedCredentials)
					: refreshedCredentials.access;
				result = { newCredentials: refreshedCredentials, apiKey };
			} else {
				const refreshedCredentials = await this.#refreshOAuthCredential(
					provider,
					selection.credential,
					credentialId,
					options?.signal,
				);
				const oauthCreds: Record<string, OAuthCredentials> = {
					[provider]: refreshedCredentials,
				};
				result = await getOAuthApiKey(provider as OAuthProvider, oauthCreds);
			}
			if (!result) return undefined;
			const updated: OAuthCredential = {
				type: "oauth",
				access: result.newCredentials.access,
				refresh: result.newCredentials.refresh,
				expires: result.newCredentials.expires,
				accountId: result.newCredentials.accountId ?? selection.credential.accountId,
				email: result.newCredentials.email ?? selection.credential.email,
				projectId: result.newCredentials.projectId ?? selection.credential.projectId,
				enterpriseUrl: result.newCredentials.enterpriseUrl ?? selection.credential.enterpriseUrl,
				apiEndpoint: result.newCredentials.apiEndpoint ?? selection.credential.apiEndpoint,
				orgId: result.newCredentials.orgId ?? selection.credential.orgId,
				orgName: result.newCredentials.orgName ?? selection.credential.orgName,
			};
			if (credentialId !== undefined) {
				const idx = this.#persistRefreshedCredentialById(provider, credentialId, updated);
				if (idx !== -1) selection.index = idx;
			} else {
				this.#replaceCredentialAt(provider, selection.index, updated);
			}
			if ((checkUsage && !allowBlocked) || hasPlanRequirement) {
				const sameAccount = selection.credential.accountId === updated.accountId;
				if (!usageChecked || !sameAccount) {
					usage = await this.#getUsageReport(provider, updated, {
						...options,
						timeoutMs: this.#usageRequestTimeoutMs,
					});
					usageChecked = true;
				}
				if (applyPlanFilter && getOpenAICodexPlanEligibility(usage, planRequirement) !== true) {
					return undefined;
				}
				if (checkUsage && !allowBlocked && usage && strategy && rankingContext) {
					const scopedLimits = this.#getScopedUsageLimits(strategy, usage, rankingContext);
					if (this.#isUsageLimitReached(scopedLimits)) {
						const resetAtMs = this.#getUsageResetAtMs(scopedLimits, Date.now());
						this.#markCredentialBlocked(
							provider,
							providerKey,
							selection.index,
							resetAtMs ?? Date.now() + AuthStorage.#defaultBackoffMs,
							blockScope,
						);
						return undefined;
					}
				}
			}
			this.#recordOAuthBearerCredentialId(provider, result.apiKey, credentialId);
			this.#recordSessionCredential(provider, sessionId, "oauth", selection.index);
			return { apiKey: result.apiKey, credential: updated, credentialId };
		} catch (error) {
			const errorMsg = String(error);
			const isDefinitiveFailure = AIError.isDefinitiveOAuthFailure(errorMsg);

			logger.warn("OAuth token refresh failed", {
				provider,
				index: selection.index,
				error: errorMsg,
				isDefinitiveFailure,
			});

			if (isDefinitiveFailure) {
				// Verify credential was not rotated by peer before disabling.
				if (credentialId !== undefined) {
					const latestRow = this.#store.listAuthCredentials(provider).find(row => row.id === credentialId);
					const latestCredential = latestRow?.credential;
					if (latestCredential?.type === "oauth" && latestCredential.refresh !== selection.credential.refresh) {
						logger.debug("OAuth refresh race detected; another process rotated token first", {
							provider,
							index: selection.index,
							credentialId,
						});
						await this.reload();
						if (allowFallback) return this.#resolveOAuthSelection(provider, sessionId, options);
					}
				}
				const disabled =
					credentialId !== undefined
						? this.#disableCredentialByIdIfMatches(
								provider,
								credentialId,
								selection.credential,
								`oauth refresh failed: ${errorMsg}`,
							)
						: this.#tryDisableCredentialAtIfMatches(
								provider,
								selection.index,
								selection.credential,
								`oauth refresh failed: ${errorMsg}`,
							);
				if (!disabled) {
					logger.debug("OAuth refresh disable lost CAS; reloading after peer rotation", {
						provider,
						index: selection.index,
					});
					await this.reload();
					if (allowFallback) return this.#resolveOAuthSelection(provider, sessionId, options);
				}
				if (this.#getCredentialsForProvider(provider).some(credential => credential.type === "oauth")) {
					if (allowFallback) return this.#resolveOAuthSelection(provider, sessionId, options);
				}
			} else {
				this.#markCredentialBlocked(provider, providerKey, selection.index, Date.now() + 5 * 60 * 1000);
			}
		}

		return undefined;
	}

	async peekApiKey(provider: string): Promise<string | undefined> {
		const runtimeKey = this.#runtimeOverrides.get(provider);
		if (runtimeKey) {
			return runtimeKey;
		}

		const configKey = this.#configOverrides.get(provider);
		if (configKey) {
			return configKey;
		}

		const oauthSelection = this.#selectCredentialByType(provider, "oauth");
		if (oauthSelection) {
			const expiresAt = oauthSelection.credential.expires;
			if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
				if (provider === "github-copilot") {
					return JSON.stringify({
						token: oauthSelection.credential.access,
						enterpriseUrl: oauthSelection.credential.enterpriseUrl,
						apiEndpoint: oauthSelection.credential.apiEndpoint,
					});
				}
				return oauthSelection.credential.access;
			}
		}

		const loginApiKeySelection = this.#selectCredentialByType(
			provider,
			"api_key",
			undefined,
			credential => credential.type === "api_key" && credential.source === "login",
		);
		if (loginApiKeySelection) {
			return this.#configValueResolver(loginApiKeySelection.credential.key);
		}

		const envKey = getEnvApiKey(provider);
		if (envKey) return envKey;

		const apiKeySelection = this.#selectCredentialByType(provider, "api_key");
		if (apiKeySelection) {
			return this.#configValueResolver(apiKeySelection.credential.key);
		}

		return this.#fallbackResolver?.(provider) ?? undefined;
	}

	async getApiKey(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<string | undefined> {
		const runtimeKey = this.#runtimeOverrides.get(provider);
		if (runtimeKey) {
			return runtimeKey;
		}

		const configKey = this.#configOverrides.get(provider);
		if (configKey) {
			return configKey;
		}

		const oauthResolved = await this.#resolveOAuthSelection(provider, sessionId, options);
		if (oauthResolved) {
			return oauthResolved.apiKey;
		}
		const loginApiKeySelection = await this.#selectApiKeyCredential(
			provider,
			sessionId,
			options,
			credential => credential.source === "login",
		);
		if (loginApiKeySelection) {
			this.#recordSessionCredential(provider, sessionId, "api_key", loginApiKeySelection.index);
			return this.#configValueResolver(loginApiKeySelection.credential.key);
		}

		if (sessionId) this.#sessionLastCredential.get(provider)?.delete(sessionId);

		const envKey = getEnvApiKey(provider);
		if (envKey) return envKey;
		const apiKeySelection = await this.#selectApiKeyCredential(
			provider,
			sessionId,
			options,
			credential => credential.source !== "login",
		);
		if (apiKeySelection) {
			this.#recordSessionCredential(provider, sessionId, "api_key", apiKeySelection.index);
			return this.#configValueResolver(apiKeySelection.credential.key);
		}

		return this.#fallbackResolver?.(provider) ?? undefined;
	}

	async getOAuthAccess(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
	): Promise<OAuthAccess | undefined> {
		if (this.#runtimeOverrides.has(provider) || this.#configOverrides.has(provider)) {
			return undefined;
		}
		const resolved = await this.#resolveOAuthSelection(provider, sessionId, options);
		if (!resolved) return undefined;
		const { credential, credentialId } = resolved;
		return {
			accessToken: credential.access,
			credentialId,
			accountId: credential.accountId,
			email: credential.email,
			projectId: credential.projectId,
			enterpriseUrl: credential.enterpriseUrl,
			apiEndpoint: credential.apiEndpoint,
			orgId: credential.orgId,
			orgName: credential.orgName,
		};
	}

	#getStoredOAuthSelections(provider: string): StoredOAuthSelection[] {
		return this.#getStoredCredentials(provider)
			.map((entry, index) => ({ credentialId: entry.id, credential: entry.credential, index }))
			.filter((entry): entry is StoredOAuthSelection => entry.credential.type === "oauth");
	}

	async #resolveStoredOAuthAccess(
		provider: string,
		selection: StoredOAuthSelection,
		providerKey: string,
		options: AuthApiKeyOptions | undefined,
	): Promise<OAuthAccessResolution> {
		try {
			const resolved = await this.#tryOAuthCredential(
				provider,
				{ credential: selection.credential, index: selection.index },
				providerKey,
				undefined,
				options,
				{ checkUsage: false, allowBlocked: true, allowFallback: false },
			);
			if (!resolved) {
				return {
					ok: false,
					credentialId: selection.credentialId,
					accountId: selection.credential.accountId,
					email: selection.credential.email,
					projectId: selection.credential.projectId,
					enterpriseUrl: selection.credential.enterpriseUrl,
					orgId: selection.credential.orgId,
					orgName: selection.credential.orgName,
					error: "OAuth access unavailable",
				};
			}
			const { credential } = resolved;
			return {
				ok: true,
				credentialId: selection.credentialId,
				accessToken: credential.access,
				accountId: credential.accountId,
				email: credential.email,
				projectId: credential.projectId,
				enterpriseUrl: credential.enterpriseUrl,
				orgId: credential.orgId,
				orgName: credential.orgName,
			};
		} catch (error) {
			return {
				ok: false,
				credentialId: selection.credentialId,
				accountId: selection.credential.accountId,
				email: selection.credential.email,
				projectId: selection.credential.projectId,
				enterpriseUrl: selection.credential.enterpriseUrl,
				orgId: selection.credential.orgId,
				orgName: selection.credential.orgName,
				error: errorMessage(error),
			};
		}
	}

	listOAuthAccounts(provider: string): OAuthAccountSummary[] {
		if (this.#runtimeOverrides.has(provider) || this.#configOverrides.has(provider)) {
			return [];
		}
		return this.#getStoredOAuthSelections(provider).map((selection, position) => ({
			position,
			credentialId: selection.credentialId,
			accountId: selection.credential.accountId,
			email: selection.credential.email,
			projectId: selection.credential.projectId,
			enterpriseUrl: selection.credential.enterpriseUrl,
			orgId: selection.credential.orgId,
			orgName: selection.credential.orgName,
		}));
	}

	async getOAuthAccesses(provider: string, options?: AuthApiKeyOptions): Promise<OAuthAccessResolution[]> {
		if (this.#runtimeOverrides.has(provider) || this.#configOverrides.has(provider)) {
			return [];
		}
		const providerKey = this.#getProviderTypeKey(provider, "oauth");
		return Promise.all(
			this.#getStoredOAuthSelections(provider).map(selection =>
				this.#resolveStoredOAuthAccess(provider, selection, providerKey, options),
			),
		);
	}

	async getOAuthAccessAt(
		provider: string,
		position: number,
		options?: AuthApiKeyOptions,
	): Promise<OAuthAccessResolution | undefined> {
		if (this.#runtimeOverrides.has(provider) || this.#configOverrides.has(provider)) {
			return undefined;
		}
		const selection = this.#getStoredOAuthSelections(provider)[position];
		if (!selection) return undefined;
		const providerKey = this.#getProviderTypeKey(provider, "oauth");
		return this.#resolveStoredOAuthAccess(provider, selection, providerKey, options);
	}

	async listResetCredits(options?: {
		provider?: string;
		sessionId?: string;
		baseUrlResolver?: (provider: string) => string | undefined;
		signal?: AbortSignal;
	}): Promise<ResetCreditAccountStatus[]> {
		const provider = options?.provider ?? "openai-codex";
		const accesses = await this.getOAuthAccesses(provider);
		if (accesses.length === 0) return [];
		const baseUrl = options?.baseUrlResolver?.(provider);
		const activeId = this.getOAuthAccountIdentity(provider, options?.sessionId);
		return Promise.all(
			accesses.map(async (access): Promise<ResetCreditAccountStatus> => {
				const active =
					!!activeId &&
					((!!activeId.accountId && activeId.accountId === access.accountId) ||
						(!!activeId.email && activeId.email === access.email));
				const base = {
					credentialId: access.credentialId,
					accountId: access.accountId,
					email: access.email,
					active,
				};
				if (!access.ok) return { ...base, availableCount: 0, credits: [], error: access.error };
				const list = await listCodexResetCredits({
					accessToken: access.accessToken,
					accountId: access.accountId,
					baseUrl,
					fetch: this.#usageFetch,
					signal: options?.signal,
				});
				if (!list) return { ...base, availableCount: 0, credits: [], error: "Failed to load saved resets" };
				return { ...base, availableCount: list.availableCount, credits: list.credits };
			}),
		);
	}

	async redeemResetCredit(options: {
		target: ResetCreditTarget;
		provider?: string;
		creditId?: string;
		baseUrlResolver?: (provider: string) => string | undefined;
		signal?: AbortSignal;
	}): Promise<ResetCreditRedeemOutcome> {
		const provider = options.provider ?? "openai-codex";
		const baseUrl = options.baseUrlResolver?.(provider);
		const { target } = options;
		const accesses = await this.getOAuthAccesses(provider);
		const match = accesses.find(
			access =>
				(target.credentialId !== undefined && access.credentialId === target.credentialId) ||
				(!!target.accountId && access.accountId === target.accountId) ||
				(!!target.email && access.email === target.email),
		);
		if (!match) return { ok: false, code: "no_account", accountId: target.accountId, email: target.email };
		if (!match.ok) {
			return { ok: false, code: "account_unavailable", accountId: match.accountId, email: match.email };
		}

		let creditId = options.creditId;
		if (!creditId) {
			const list = await listCodexResetCredits({
				accessToken: match.accessToken,
				accountId: match.accountId,
				baseUrl,
				fetch: this.#usageFetch,
				signal: options.signal,
			});
			const credit = list?.credits.find(entry => (entry.status ?? "available") === "available") ?? list?.credits[0];
			if (!credit) return { ok: false, code: "no_credit", accountId: match.accountId, email: match.email };
			creditId = credit.id;
		}

		const result = await consumeCodexResetCredit({
			creditId,
			accessToken: match.accessToken,
			accountId: match.accountId,
			baseUrl,
			fetch: this.#usageFetch,
			signal: options.signal,
		});
		if (result.ok) {
			this.#invalidateUsageReportCache(provider, baseUrl);
			if (this.#store.invalidateUsageCache) {
				await this.#store.invalidateUsageCache(options.signal).catch(err => {
					logger.debug("Failed to notify store of stale usage", { err });
				});
			}
			if (match.credentialId !== undefined) this.clearCredentialBlocks(provider, match.credentialId);
		}
		return { ok: result.ok, code: result.code, accountId: match.accountId, email: match.email, creditId };
	}

	#invalidateUsageReportCache(provider: string, baseUrl?: string): void {
		this.#usageCacheEpoch += 1;
		const expired = Date.now() - 1;
		for (const entry of this.#getStoredCredentials(provider)) {
			if (entry.credential.type !== "oauth") continue;
			const cacheKey = this.#buildUsageReportCacheKey(
				this.#buildUsageRequestForOauth(provider, entry.credential, baseUrl),
			);
			const existing = this.#usageCache.getStale<UsageReport | null>(cacheKey);
			this.#usageCache.set(cacheKey, { value: existing?.value ?? null, expiresAt: expired });
		}
	}

	async invalidateUsageCache(provider?: string, signal?: AbortSignal): Promise<void> {
		if (provider) {
			this.#invalidateUsageReportCache(provider);
		} else {
			this.#usageCacheEpoch += 1;
			const expired = Date.now() - 1;
			try {
				const credentials = this.#store.listAuthCredentials();
				for (const entry of credentials) {
					if (entry.credential.type !== "oauth") continue;
					const cacheKey = this.#buildUsageReportCacheKey(
						this.#buildUsageRequestForOauth(entry.provider, entry.credential),
					);
					const existing = this.#usageCache.getStale<UsageReport | null>(cacheKey);
					this.#usageCache.set(cacheKey, { value: existing?.value ?? null, expiresAt: expired });
				}
			} catch (err) {
				logger.debug("Failed to list auth credentials for complete usage cache invalidation", { err });
			}
		}

		if (this.#store.invalidateUsageCache) {
			await this.#store.invalidateUsageCache(signal).catch(err => {
				logger.debug("Failed to notify store of stale usage", { err });
			});
		}
	}

	#invalidateUsageReportCacheForProviderKey(providerKey: string): void {
		const oauthSuffix = ":oauth";
		if (!providerKey.endsWith(oauthSuffix)) return;
		this.#invalidateUsageReportCache(providerKey.slice(0, -oauthSuffix.length));
	}

	clearCredentialBlocks(provider: string, credentialId: number): void {
		try {
			this.deleteCredentialBlocks(credentialId);
		} catch (err) {
			logger.debug("Failed to clear persisted credential blocks", { err, provider, credentialId });
		}
		this.#authDeadCredentials.delete(credentialId);

		const stored = this.#getStoredCredentials(provider);
		const index = stored.findIndex(entry => entry.id === credentialId);
		if (index < 0) return;
		const providerKey = this.#getProviderTypeKey(provider, stored[index]!.credential.type);
		const scopedPrefix = `${providerKey}\0`;
		for (const [key, backoffMap] of this.#credentialBackoff) {
			if (key !== providerKey && !key.startsWith(scopedPrefix)) continue;
			backoffMap.delete(index);
			if (backoffMap.size === 0) this.#credentialBackoff.delete(key);
		}
		for (const [key, probeAfterMap] of this.#credentialBackoffProbeAfter) {
			if (key !== providerKey && !key.startsWith(scopedPrefix)) continue;
			probeAfterMap.delete(index);
			if (probeAfterMap.size === 0) this.#credentialBackoffProbeAfter.delete(key);
		}
	}

	#isHealthyCodexUsageReport(report: UsageReport): boolean {
		if (report.provider !== "openai-codex") return false;
		const metadata = report.metadata;
		if (metadata?.allowed !== true || metadata.limitReached !== false) return false;
		return !this.#isUsageLimitReached(report.limits);
	}

	#reconcileCodexUsageBlockForCredential(provider: Provider, credentialId: number, report: UsageReport): void {
		if (!this.#isHealthyCodexUsageReport(report)) return;
		const providerKey = this.#getProviderTypeKey(provider, "oauth");
		const credentialIndex = this.#getStoredCredentials(provider).findIndex(entry => entry.id === credentialId);
		if (credentialIndex < 0) return;
		const blockScope = this.#rankingStrategyResolver?.(provider)?.blockScope?.({});
		const blockedUntilMs = this.#getCredentialBlockedUntil(provider, providerKey, credentialIndex, blockScope);
		if (blockedUntilMs === undefined) return;
		const nowMs = Date.now();
		const scopedBackoffKey = this.#toScopedBackoffKey(providerKey, blockScope);
		const globalProbeAfterMs = this.#credentialBackoffProbeAfter.get(providerKey)?.get(credentialIndex) ?? 0;
		const scopedProbeAfterMs = this.#credentialBackoffProbeAfter.get(scopedBackoffKey)?.get(credentialIndex) ?? 0;
		const getStoreReconcileAfter = this.#store.getCredentialBlockReconcileAfter?.bind(this.#store);
		const storeGlobalProbeAfterMs = getStoreReconcileAfter?.(credentialId, providerKey, "") ?? 0;
		const storeScopedProbeAfterMs = getStoreReconcileAfter?.(credentialId, providerKey, blockScope ?? "") ?? 0;
		if (Math.max(globalProbeAfterMs, scopedProbeAfterMs, storeGlobalProbeAfterMs, storeScopedProbeAfterMs) > nowMs) {
			return;
		}
		this.clearCredentialBlocks(provider, credentialId);
		logger.info("Cleared stale Codex usage-limit block after healthy live usage report", {
			credentialId,
			provider,
			clearedBlockedUntilMs: blockedUntilMs,
		});
	}

	#reconcileCodexUsageBlock(request: UsageRequestDescriptor, report: UsageReport): void {
		if (request.provider !== "openai-codex") return;
		const credentialId = this.#findStoredCredentialIdForUsageCredential(request.provider, request.credential);
		if (credentialId === undefined) return;
		this.#reconcileCodexUsageBlockForCredential(request.provider, credentialId, report);
	}

	#findStoredCredentialIdsForUsageReport(report: UsageReport): number[] {
		if (report.provider !== "openai-codex") return [];
		const email = this.#getUsageReportMetadataValue(report, "email")?.toLowerCase();
		const accountId = (
			this.#getUsageReportMetadataValue(report, "accountId") ?? this.#getUsageReportScopeAccountId(report)
		)?.toLowerCase();
		if (!email && !accountId) return [];
		const matches: number[] = [];
		for (const entry of this.#getStoredCredentials(report.provider)) {
			const credential = entry.credential;
			if (credential.type !== "oauth") continue;
			const credentialEmail = credential.email?.trim().toLowerCase();
			const credentialAccountId = credential.accountId?.trim().toLowerCase();
			if ((email && credentialEmail === email) || (accountId && credentialAccountId === accountId)) {
				matches.push(entry.id);
			}
		}
		return matches;
	}

	#reconcileCodexUsageBlocksFromReports(reports: UsageReport[]): void {
		const reconciled = new Set<number>();
		for (const report of reports) {
			if (!this.#isHealthyCodexUsageReport(report)) continue;
			for (const credentialId of this.#findStoredCredentialIdsForUsageReport(report)) {
				if (reconciled.has(credentialId)) continue;
				reconciled.add(credentialId);
				this.#reconcileCodexUsageBlockForCredential(report.provider, credentialId, report);
			}
		}
	}

	#extractStructuredApiKeyToken(apiKey: string): string | undefined {
		if (!apiKey.startsWith("{")) return undefined;
		try {
			const parsed = JSON.parse(apiKey) as { token?: unknown };
			return typeof parsed.token === "string" ? parsed.token : undefined;
		} catch {
			return undefined;
		}
	}

	async #credentialMatchesApiKey(credential: AuthCredential, apiKey: string): Promise<boolean> {
		if (credential.type === "api_key") {
			return (await this.#configValueResolver(credential.key)) === apiKey;
		}
		if (credential.access === apiKey) return true;
		return this.#extractStructuredApiKeyToken(apiKey) === credential.access;
	}

	async invalidateCredentialMatching(
		provider: string,
		apiKey: string,
		options?: InvalidateCredentialMatchingOptions,
	): Promise<boolean>;
	async invalidateCredentialMatching(provider: string, apiKey: string, signal?: AbortSignal): Promise<boolean>;
	async invalidateCredentialMatching(
		provider: string,
		apiKey: string,
		optionsOrSignal?: InvalidateCredentialMatchingOptions | AbortSignal,
	): Promise<boolean> {
		const signal = isAbortSignalOption(optionsOrSignal) ? optionsOrSignal : optionsOrSignal?.signal;
		const sessionId = isAbortSignalOption(optionsOrSignal) ? undefined : optionsOrSignal?.sessionId;
		const stored = this.#getStoredCredentials(provider);
		let matched: { id: number; type: AuthCredential["type"]; index: number } | undefined;
		for (let index = 0; index < stored.length; index++) {
			const entry = stored[index];
			if (entry && (await this.#credentialMatchesApiKey(entry.credential, apiKey))) {
				matched = { id: entry.id, type: entry.credential.type, index };
				break;
			}
		}

		if (!matched) {
			await this.reload();
			return false;
		}

		this.#clearSessionCredential(provider, sessionId);
		this.#markCredentialBlocked(
			provider,
			this.#getProviderTypeKey(provider, matched.type),
			matched.index,
			Date.now() + AuthStorage.#defaultBackoffMs,
		);

		const markSuspect = this.#store.markCredentialSuspect?.bind(this.#store);
		if (markSuspect) {
			await markSuspect(matched.id, { signal });
		} else {
			await this.reload();
		}

		const latestRows = this.#store.listAuthCredentials(provider);
		this.#setStoredCredentials(
			provider,
			latestRows.map(row => ({ id: row.id, credential: row.credential })),
		);
		return true;
	}

	async rotateSessionCredential(
		provider: string,
		sessionId: string | undefined,
		options?: { error?: unknown; modelId?: string; apiKey?: string; credentialId?: number; signal?: AbortSignal },
	): Promise<boolean> {
		const error = options?.error;
		if (AIError.isUsageLimit(error)) {
			return (
				await this.markUsageLimitReached(provider, sessionId, {
					modelId: options?.modelId,
					apiKey: options?.apiKey,
					credentialId: options?.credentialId,
					signal: options?.signal,
				})
			).switched;
		}

		const sessionCredential = await this.#resolveCredentialTarget(provider, sessionId, {
			credentialId: options?.credentialId,
			apiKey: options?.apiKey,
		});
		if (!sessionCredential) return false;

		const providerKey = this.#getProviderTypeKey(provider, sessionCredential.type);
		const hasSibling = this.#getCredentialsForProvider(provider).some(
			(credential, index) =>
				credential.type === sessionCredential.type &&
				index !== sessionCredential.index &&
				!this.#isCredentialBlocked(provider, providerKey, index),
		);
		const target = this.#getStoredCredentials(provider)[sessionCredential.index];
		const sticky = this.#getSessionCredential(provider, sessionId);
		if (
			!sessionCredential.explicit ||
			(sticky?.type === sessionCredential.type && sticky.index === sessionCredential.index)
		) {
			this.#clearSessionCredential(provider, sessionId);
		}
		if (target) this.#authDeadCredentials.add(target.id);
		this.#markCredentialBlocked(
			provider,
			providerKey,
			sessionCredential.index,
			Date.now() + AuthStorage.#defaultBackoffMs,
		);

		if (hasSibling && target) {
			this.#pendingFailover.set(provider, {
				from: { credentialId: target.id, label: this.#accountNoticeLabel(provider, target.id) },
				cause: authFailureCause(error),
				at: Date.now(),
			});
		}

		if (target) {
			const markSuspect = this.#store.markCredentialSuspect?.bind(this.#store);
			if (markSuspect) {
				await markSuspect(target.id, { signal: options?.signal });
			} else {
				await this.reload();
			}
			const latestRows = this.#store.listAuthCredentials(provider);
			this.#setStoredCredentials(
				provider,
				latestRows.map(row => ({ id: row.id, credential: row.credential })),
			);
		}

		return hasSibling;
	}

	resolver(provider: string, options?: { sessionId?: string; baseUrl?: string; modelId?: string }): ApiKeyResolver {
		const { sessionId, baseUrl, modelId } = options ?? {};
		return async ({ lastChance, error, signal, previousKey }) => {
			if (error === undefined) {
				return this.getApiKey(provider, sessionId, { baseUrl, modelId, signal });
			}
			if (lastChance) {
				const switched = await this.rotateSessionCredential(provider, sessionId, {
					error,
					modelId,
					signal,
					apiKey: previousKey,
				});
				if (!switched) {
					if (AIError.isUsageLimit(error)) return undefined;
				}
				return this.getApiKey(provider, sessionId, { baseUrl, modelId, signal });
			}
			return this.getApiKey(provider, sessionId, { baseUrl, modelId, forceRefresh: true, signal });
		};
	}

	exportSnapshot(): AuthCredentialSnapshot {
		const entries: AuthCredentialSnapshotEntry[] = [];
		for (const [provider, stored] of this.#data) {
			for (const entry of stored) {
				const credential = entry.credential;
				const redacted: SnapshotCredential =
					credential.type === "api_key" ? credential : { ...credential, refresh: REMOTE_REFRESH_SENTINEL };
				entries.push({
					id: entry.id,
					provider,
					credential: redacted,
					identityKey: resolveCredentialIdentityKey(provider, credential),
				});
			}
		}
		return { generation: this.#generation, generatedAt: Date.now(), credentials: entries };
	}

	async refreshCredentialById(id: number, signal?: AbortSignal): Promise<AuthCredentialSnapshotEntry> {
		const existing = this.#oauthRefreshInFlight.get(id);
		if (existing) return raceCredentialRefreshWithSignal(existing, signal);

		const promise = (async () => {
			this.#bumpGeneration("credential-refresh-start");
			try {
				return await this.#forceRefreshCredentialByIdUnshared(id, signal);
			} catch (error) {
				this.#bumpGeneration("credential-refresh-failure");
				throw error;
			} finally {
				this.#oauthRefreshInFlight.delete(id);
			}
		})();
		this.#oauthRefreshInFlight.set(id, promise);
		return raceCredentialRefreshWithSignal(promise, signal);
	}

	async forceRefreshCredentialById(id: number, signal?: AbortSignal): Promise<AuthCredentialSnapshotEntry> {
		return this.refreshCredentialById(id, signal);
	}

	async #forceRefreshCredentialByIdUnshared(id: number, signal?: AbortSignal): Promise<AuthCredentialSnapshotEntry> {
		for (const [provider, entries] of this.#data) {
			const index = entries.findIndex(entry => entry.id === id);
			if (index === -1) continue;
			const target = entries[index];
			if (target.credential.type !== "oauth") {
				throw new AIError.ValidationError(
					`Credential ${id} is not OAuth (provider=${provider}, type=${target.credential.type})`,
				);
			}
			const attempted = target.credential;
			const stale: OAuthCredential = { ...attempted, expires: 0 };
			let refreshed: OAuthCredentials;
			try {
				refreshed = await this.#refreshOAuthCredential(provider as Provider, stale, id, signal);
			} catch (error) {
				if (AIError.isDefinitiveOAuthFailure(String(error))) {
					if (
						!this.#disableCredentialByIdIfMatches(
							provider,
							id,
							attempted,
							`oauth refresh failed: ${String(error)}`,
						)
					) {
						await this.reload();
					}
				}
				throw error;
			}
			const updated: OAuthCredential = {
				type: "oauth",
				access: refreshed.access,
				refresh: refreshed.refresh,
				expires: refreshed.expires,
				accountId: refreshed.accountId ?? attempted.accountId,
				email: refreshed.email ?? attempted.email,
				projectId: refreshed.projectId ?? attempted.projectId,
				enterpriseUrl: refreshed.enterpriseUrl ?? attempted.enterpriseUrl,
				apiEndpoint: refreshed.apiEndpoint ?? attempted.apiEndpoint,
				orgId: refreshed.orgId ?? attempted.orgId,
				orgName: refreshed.orgName ?? attempted.orgName,
			};
			if (this.#persistRefreshedCredentialById(provider, id, updated) === -1) {
				throw new AIError.ValidationError(`No credential with id=${id}`);
			}
			return {
				id,
				provider,
				credential: { ...updated, refresh: REMOTE_REFRESH_SENTINEL },
				identityKey: resolveCredentialIdentityKey(provider, updated),
			};
		}
		throw new AIError.ValidationError(`No credential with id=${id}`);
	}

	disableCredentialById(id: number, disabledCause: string): boolean {
		for (const [provider, entries] of this.#data) {
			const index = entries.findIndex(entry => entry.id === id);
			if (index === -1) continue;
			this.#store.deleteAuthCredential(id, disabledCause);
			const next = entries.filter((_value, idx) => idx !== index);
			this.#setStoredCredentials(provider, next);
			this.#resetProviderAssignments(provider);
			this.#emitCredentialDisabled({ provider, disabledCause });
			return true;
		}
		return false;
	}

	upsertCredential(provider: string, credential: AuthCredential): AuthCredentialSnapshotEntry[] {
		const stored = this.#store.upsertAuthCredentialForProvider(provider, credential);
		this.#setStoredCredentials(
			provider,
			stored.map(entry => ({ id: entry.id, credential: entry.credential })),
		);
		this.#resetProviderAssignments(provider);
		return stored.map(entry => {
			const persisted = entry.credential;
			const redacted: SnapshotCredential =
				persisted.type === "api_key" ? persisted : { ...persisted, refresh: REMOTE_REFRESH_SENTINEL };
			return {
				id: entry.id,
				provider: entry.provider,
				credential: redacted,
				identityKey: resolveCredentialIdentityKey(provider, persisted),
			};
		});
	}

	listCredentialBlocks(credentialIds: readonly number[]): StoredCredentialBlock[] {
		return this.#store.listCredentialBlocks?.(credentialIds) ?? [];
	}

	upsertCredentialBlock(block: StoredCredentialBlock): void {
		const upsertCredentialBlock = this.#store.upsertCredentialBlock?.bind(this.#store);
		if (!upsertCredentialBlock) return;
		upsertCredentialBlock(block);
		this.#invalidateUsageReportCacheForProviderKey(block.providerKey);
		this.#bumpGeneration("credential-block");
	}

	deleteCredentialBlocks(credentialId: number): void {
		const deleteCredentialBlocks = this.#store.deleteCredentialBlocks?.bind(this.#store);
		if (!deleteCredentialBlocks) return;
		deleteCredentialBlocks(credentialId);
		this.#bumpGeneration("credential-block");
	}

	describeCredentialSource(provider: string, sessionId?: string): string | undefined {
		if (this.#runtimeOverrides.has(provider)) {
			return "runtime override (--api-key)";
		}
		if (this.#configOverrides.has(provider)) {
			return "config override (models.yml)";
		}

		const baseLabel = this.#sourceLabel ?? "local store";
		const stored = this.#getStoredCredentials(provider);
		const session = sessionId ? this.#sessionLastCredential.get(provider)?.get(sessionId) : undefined;
		const describeStored = (
			type: AuthCredential["type"],
			filter?: (credential: AuthCredential) => boolean,
		): string | undefined => {
			const typed = stored
				.map((entry, index) => ({ entry, index }))
				.filter(({ entry }) => entry.credential.type === type && (filter?.(entry.credential) ?? true));
			if (typed.length === 0) return undefined;
			const sticky = session?.type === type ? typed.find(entry => entry.index === session.index) : undefined;
			const chosen = sticky?.entry ?? typed[0].entry;
			const credential = chosen.credential;
			const identity =
				credential.type === "oauth"
					? (credential.email ?? credential.accountId ?? credential.projectId ?? `cred ${chosen.id}`)
					: `cred ${chosen.id}`;
			return `${baseLabel} · ${type} #${chosen.id} (${identity})`;
		};

		const oauthSource = describeStored("oauth");
		if (oauthSource) return oauthSource;
		const loginApiKeySource = describeStored(
			"api_key",
			credential => credential.type === "api_key" && credential.source === "login",
		);
		if (loginApiKeySource) return loginApiKeySource;
		if (getEnvApiKey(provider)) return `env (over ${baseLabel})`;
		const apiKeySource = describeStored(
			"api_key",
			credential => credential.type !== "api_key" || credential.source !== "login",
		);
		if (apiKeySource) return apiKeySource;
		if (this.#fallbackResolver?.(provider) !== undefined) return "fallback resolver";
		return undefined;
	}
}

export {
	isRefreshFailureDisableCause,
	isSqliteBusyError,
	OAUTH_REFRESH_FAILURE_DISABLE_PREFIX,
} from "./auth-credential-rows";

export { SqliteAuthCredentialStore };
