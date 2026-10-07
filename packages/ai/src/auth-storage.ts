/**
 * Credential management for API keys and OAuth tokens.
 *
 * `AuthStorage` selects the credential a request uses (round-robin, session stickiness, pins, usage
 * ranking, rate-limit blocks), refreshes OAuth tokens, and reads provider usage. It does not open a
 * database: rows are read and written through an `AuthCredentialStore`, and
 * `auth-storage-sqlite.ts` is the local implementation.
 *
 * The class is defined here; its vocabulary and single-concern helpers are in `./auth-storage/`:
 *
 * - `types.ts`: credential shapes, the store interface, options, events and result shapes.
 * - `http-concurrency.ts`: the process-wide cap on background authentication HTTP work.
 * - `events.ts`: notice subscribers and the generation counter.
 * - `credentials.ts`: in-memory rows and pure functions over them.
 * - `usage-cache.ts`, `usage-requests.ts`, `usage-reports.ts`: the usage-report cache, request
 *   keys, and report scoping and limits.
 * - `usage-ranking.ts`, `openai-codex-plan.ts`: candidate ordering and Codex plan tiers.
 * - `reset-credits.ts`: spending one saved usage reset.
 *
 * The public types, the sqlite store and the row predicates are re-exported from this module.
 */

import * as logger from "@veyyon/utils/logger";
import { clamp } from "@veyyon/utils/math";
import { scopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";
import { errorMessage } from "@veyyon/utils/type-guards";
// The row shapes and the pure row logic, which moved to their own module so a caller that only
// persists a credential does not import the OAuth machinery below. Re-exported at the bottom for
// the names that were public here.
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
import { CredentialBlocks } from "./auth-storage/credential-blocks";
import { CredentialRouting } from "./auth-storage/credential-routing";
import type {
	ApiKeySelection,
	AuthApiKeyOptions,
	OAuthResolutionResult,
	OAuthSelection,
	StoredCredential,
	StoredOAuthSelection,
} from "./auth-storage/credentials";
import {
	authCredentialEquals,
	authFailureCause,
	buildCompletionProbeCredential,
	dedupeOAuthCredentials,
	extractStructuredApiKeyToken,
	fingerprintOAuthBearer,
	getHashedIndex,
	getProviderTypeKey,
	isAbortSignalOption,
	matchStoredCredentialId,
	OAUTH_BEARER_FINGERPRINT_HISTORY_LIMIT,
	resolveOAuthDedupeIdentityKey,
	storedCredentialArraysEqual,
} from "./auth-storage/credentials";
import { AuthStorageEvents } from "./auth-storage/events";
import { withAuthHttpConcurrency } from "./auth-storage/http-concurrency";
import {
	OAUTH_REFRESH_LEASE_POLL_MS,
	OAUTH_REFRESH_LEASE_TTL_MS,
	OAUTH_REFRESH_SKEW_MS,
	OAuthRefresher,
} from "./auth-storage/oauth-refresh";
import type { OpenAICodexPlanRequirement } from "./auth-storage/openai-codex-plan";
import {
	getOpenAICodexPlanEligibility,
	getOpenAICodexPlanPriority,
	resolveOpenAICodexPlanRequirement,
} from "./auth-storage/openai-codex-plan";
import { spendAnthropicReset, spendCodexReset } from "./auth-storage/reset-credits";
import type {
	ApiKeyCredential,
	AuthCredential,
	AuthCredentialEntry,
	AuthCredentialSnapshot,
	AuthCredentialSnapshotEntry,
	AuthCredentialStore,
	AuthStorageData,
	AuthStorageOptions,
	CheckCredentialsOptions,
	CredentialDisabledEvent,
	CredentialFailoverEvent,
	CredentialHealthResult,
	CredentialOrigin,
	InvalidateCredentialMatchingOptions,
	OAuthAccess,
	OAuthAccessResolution,
	OAuthAccountIdentity,
	OAuthAccountSummary,
	OAuthCredential,
	OAuthLoginIdentity,
	ResetCreditAccountStatus,
	ResetCreditProvider,
	ResetCreditRedeemOutcome,
	ResetCreditTarget,
	SessionCredentialRouting,
	SnapshotCredential,
	StoredAuthCredential,
	StoredCredentialBlock,
	StoredOAuthRefreshOptions,
	StoredOAuthRefreshResult,
	UsageLimitMarkResult,
	UsageLimitWithheldEvent,
} from "./auth-storage/types";
import { REMOTE_REFRESH_SENTINEL, RESET_CREDIT_PROVIDERS } from "./auth-storage/types";
import type { UsageCache } from "./auth-storage/usage-cache";
import { AuthStorageUsageCache } from "./auth-storage/usage-cache";
import type {
	ApiKeyCandidate,
	OAuthCandidate,
	UsageCandidate,
	UsageRankedCandidate,
	UsageRankingResult,
} from "./auth-storage/usage-ranking";
import {
	computeWindowRequiredDrain,
	leadWithChosenAccount,
	normalizeUsageFraction,
	orderUsageRankedCandidates,
} from "./auth-storage/usage-ranking";
import {
	getScopedUsageLimits,
	getUsageReportIdentifiers,
	getUsageReportMetadataValue,
	getUsageReportScopeAccountId,
	getUsageResetAtMs,
	isHealthyCodexUsageReport,
	isUsageLimitExhausted,
	isUsageLimitReached,
	mergeUsageReportGroup,
} from "./auth-storage/usage-reports";
import type { UsageRequestDescriptor } from "./auth-storage/usage-requests";
import {
	buildRefreshableOauthCredential,
	buildUsageCacheIdentity,
	buildUsageCredential,
	buildUsageReportCacheKey,
	buildUsageReportsCacheKey,
	buildUsageRequest,
	buildUsageRequestForOauth,
	isUsageCredentialRow,
	mergeRefreshedUsageCredential,
} from "./auth-storage/usage-requests";
// The store class itself, for the `AuthStorage.create` convenience factory. The edge runs ONE way:
// this module names the store, and the store names this module only for TYPES, which are erased. So
// importing the store alone does not pull the OAuth machinery below, which is the whole point.
import { SqliteAuthCredentialStore } from "./auth-storage-sqlite";
// The env-key leaf, NOT `./stream`. This file wanted two table lookups and was pulling the whole
// streaming engine for them, which is most of why importing auth storage reached 276 modules.
import { getEnvApiKey, getEnvApiKeyName } from "./env-api-key";
import * as AIError from "./error";
import { getProviderDefinition, PASTE_CODE_LOGIN_PROVIDERS } from "./registry";
import { getOAuthApiKey, getOAuthProvider } from "./registry/oauth";
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
import {
	anthropicResetAvailableCount,
	anthropicResetCredits,
	fetchAnthropicResetStatus,
} from "./usage/anthropic-reset";
import { listCodexResetCredits } from "./usage/openai-codex-reset";
import {
	listRegisteredUsageProviders,
	resolveRegisteredRankingStrategy,
	resolveRegisteredUsageProvider,
} from "./usage/registry";
import { raceWithSignal } from "./utils/abort";

export * from "./auth-storage/http-concurrency";
export * from "./auth-storage/types";

/**
 * How long an auth-death failover stays pending before it is dropped unannounced.
 *
 * The notice describes the request that is retrying right now. If no resolve lands inside this
 * window the retry was abandoned, and firing then would announce a move that never happened.
 */
const FAILOVER_NOTICE_WINDOW_MS = 60_000;

// ─────────────────────────────────────────────────────────────────────────────
// Default Config Value Resolver
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default config value resolver that checks env vars and treats as literal.
 * Does NOT support "!command" syntax (that requires veyyon-natives).
 */
async function defaultConfigValueResolver(config: string): Promise<string | undefined> {
	const envValue = process.env[config];
	return envValue || config;
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage Providers (defaults)
// ─────────────────────────────────────────────────────────────────────────────

// The provider table itself lives in `usage/defaults.ts` and is reached through `usage/registry.ts`.
// A credential store has no business knowing how each provider reports its quota, and importing the
// eleven backends here is what put the streaming engine on this module's path.

// The two usage-row constants live in `auth-credential-rows.ts`; both halves of the split read them.
const USAGE_HEADER_INGEST_INTERVAL_MS = 60_000;

/**
 * Per-credential cool-down after a usage fetch fails. While this window is
 * active we serve the last successful value to avoid dropping the credential
 * from the report; without a previous value we just return null and retry
 * on the next poll.
 */
const USAGE_FAILURE_BACKOFF_MS = 10_000;
// Bumped from 3s — Claude usage retries up to 3 times with exponential backoff
// (~3.5s total worst case); a tight per-request budget aborts retries mid-cycle.
const DEFAULT_USAGE_REQUEST_TIMEOUT_MS = 10_000;

const OAUTH_REFRESH_OPERATION_TIMEOUT_MS = 10_000;

/**
 * Cap on remembered withheld-quota notice keys (one per exhausted window per account). Sized like
 * the disabled-event backlog: a handful of accounts times a handful of windows a day.
 */
const MAX_WITHHELD_QUOTA_NOTICES = 64;

function resolveDefaultUsageProvider(provider: Provider): UsageProvider | undefined {
	return resolveRegisteredUsageProvider(provider);
}

function resolveDefaultRankingStrategy(provider: Provider): CredentialRankingStrategy | undefined {
	return resolveRegisteredRankingStrategy(provider);
}

const defaultBackoffMs = 60_000;

// ─────────────────────────────────────────────────────────────────────────────
// AuthStorage Class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Credential storage backed by an AuthCredentialStore.
 * Reads from storage on reload(), manages round-robin credential selection,
 * usage limit tracking, and OAuth token refresh.
 */
export class AuthStorage {
	// Default backoff when no reset time available

	/** Provider -> credentials cache, populated from store on reload(). */
	#data: Map<string, StoredCredential[]> = new Map();
	#runtimeOverrides: Map<string, string> = new Map();
	#configOverrides: Map<string, string> = new Map();
	/** Tracks next credential index per provider:type key for round-robin distribution (non-session use). */
	#providerRoundRobinIndex: Map<string, number> = new Map();
	/** Session stickiness, session pins and the provider-wide account selection. */
	readonly #routing: CredentialRouting;
	/** Recent bearer fingerprints resolved for each durable OAuth row; used only for delayed usage-limit attribution. */
	#oauthBearerFingerprints: Map<string, Map<number, string[]>> = new Map();
	/** Temporary rate-limit blocks, in memory and persisted. */
	readonly #blocks: CredentialBlocks;
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
	/** OAuth token refresh: the single-flight, the cross-process lease and the token endpoint call. */
	readonly #refresher: OAuthRefresher;
	#fetchUsageReportsOverride?: AuthStorageOptions["fetchUsageReports"];
	#sourceLabel?: string;
	readonly #events = new AuthStorageEvents();
	/** Provider → the account auth death just retired, awaiting the resolve that names its replacement. */
	#pendingFailover: Map<string, { from: { credentialId: number; label: string }; cause: string; at: number }> =
		new Map();
	/**
	 * `provider:credentialId:retryAtMs` of every withheld-quota notice already emitted, so one
	 * exhausted window is announced once however many times the turn retries into it. Keyed by the
	 * window's own end, so the NEXT exhaustion of the same account is a new notice rather than a
	 * silent one.
	 */
	#withheldQuotaNotices: Set<string> = new Set();
	/**
	 * Exhaustion-driven movement between accounts, off unless a host opts in.
	 *
	 * {@link AuthStorageOptions.loadBalancing} has documented this as defaulting to off since it
	 * was added; the field said `true`, so every embedder that did not pass the option got account
	 * movement it never asked for, and the one host that does pass it masked the disagreement.
	 */
	#loadBalancing: boolean | (() => boolean) = false;
	/**
	 * Credential ids whose grant this process watched fail authentication, as opposed to run out of
	 * quota. Deliberately in memory and deliberately not persisted: the mark exists to stop an
	 * explicit choice from pinning traffic to an account that cannot authenticate at all, and after
	 * a restart that account deserves exactly one more attempt — the provider re-marks it in a single
	 * request if the grant really is gone, and a re-login or a lifted hold retires it.
	 *
	 * A quota hold is never recorded here. That distinction is the whole point: a hold is our own
	 * prediction about a window and must never displace an explicitly chosen account, while a dead
	 * grant is the provider's verdict and has to move the request or the session cannot proceed.
	 */
	#authDeadCredentials: Set<number> = new Set();
	#oauthRefreshInFlight: Map<number, Promise<AuthCredentialSnapshotEntry>> = new Map();
	#closed = false;

	constructor(store: AuthCredentialStore, options: AuthStorageOptions = {}) {
		this.#store = store;
		this.#configValueResolver = options.configValueResolver ?? defaultConfigValueResolver;
		this.#usageProviderResolver = options.usageProviderResolver ?? resolveDefaultUsageProvider;
		this.#rankingStrategyResolver = options.rankingStrategyResolver ?? resolveDefaultRankingStrategy;
		if (options.loadBalancing !== undefined) this.#loadBalancing = options.loadBalancing;
		if (options.onCredentialFailover) {
			// Permanent for this AuthStorage's lifetime; the unsubscribe handle is discarded.
			this.onCredentialFailover(options.onCredentialFailover);
		}
		if (options.onUsageLimitWithheld) {
			// Permanent for this AuthStorage's lifetime, exactly like the failover subscription above.
			this.onUsageLimitWithheld(options.onUsageLimitWithheld);
		}
		this.#usageCache = new AuthStorageUsageCache(this.#store);
		this.#routing = new CredentialRouting(this.#store, provider => this.#getStoredCredentials(provider));
		this.#blocks = new CredentialBlocks(
			this.#store,
			provider => this.#getStoredCredentials(provider),
			provider => this.#invalidateUsageReportCache(provider),
		);
		// Opportunistic hygiene, once per AuthStorage lifetime: drop expired
		// cache rows (24h last-good retention). A cheap indexed DELETE;
		// failures must never block construction.
		try {
			this.#store.cleanExpiredCache();
		} catch {
			// Best-effort.
		}
		try {
			this.#store.cleanExpiredCredentialBlocks?.(Date.now());
		} catch {
			// Best-effort.
		}
		this.#usageFetch = options.usageFetch ?? fetch;
		this.#usageRequestTimeoutMs = options.usageRequestTimeoutMs ?? DEFAULT_USAGE_REQUEST_TIMEOUT_MS;
		this.#refresher = new OAuthRefresher(this.#store, options.refreshOAuthCredential, (provider, id, credential) => {
			this.#persistRefreshedCredentialById(provider, id, credential);
		});
		this.#fetchUsageReportsOverride = options.fetchUsageReports;
		this.#sourceLabel = options.sourceLabel;
		if (options.onCredentialDisabled) {
			// Constructor-registered subscribers are permanent for this AuthStorage's lifetime;
			// the unsubscribe handle is intentionally discarded.
			this.onCredentialDisabled(options.onCredentialDisabled);
		}
		this.#usageLogger =
			options.usageLogger ??
			({
				debug: (message, meta) => logger.debug(message, meta),
				warn: (message, meta) => logger.warn(message, meta),
			} satisfies UsageLogger);
	}

	/**
	 * Create an AuthStorage instance backed by a AuthCredentialStore.
	 * Convenience factory for standalone use (e.g., pi-ai CLI).
	 * @param dbPath - Path to SQLite database
	 */
	static async create(dbPath: string, options: AuthStorageOptions = {}): Promise<AuthStorage> {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		return new AuthStorage(store, options);
	}

	/**
	 * Close the underlying credential store.
	 *
	 * After calling this, the instance must not be reused.
	 */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#store.close();
	}

	getGeneration(): number {
		return this.#events.generation;
	}

	onGenerationChanged(listener: (generation: number) => void): () => void {
		return this.#events.onGenerationChanged(listener);
	}

	offGenerationChanged(listener: (generation: number) => void): void {
		this.#events.offGenerationChanged(listener);
	}

	/**
	 * Subscribe to {@link CredentialDisabledEvent}s. Multiple subscribers are supported and
	 * each fires for every disable event; subscribers are invoked in registration order with
	 * exceptions and async rejections isolated per-listener so a misbehaving subscriber
	 * cannot break the disable path or starve the rest of the chain.
	 *
	 * If `credential_disabled` events were emitted while no listener was subscribed, they are
	 * replayed (in insertion order) to the listener that triggers the empty→non-empty
	 * transition. The drain is one-shot — listeners that subscribe after that no longer see
	 * past events.
	 *
	 * Returns an unsubscribe function. The function is idempotent: calling it more than once
	 * is a no-op. After every subscriber has unsubscribed, subsequent disable events buffer
	 * again until the next subscribe.
	 *
	 * @param listener Callback invoked with each disable event. May be sync or async.
	 * @returns A function that removes this listener from the subscriber set.
	 */
	onCredentialDisabled(listener: (event: CredentialDisabledEvent) => void | Promise<void>): () => void {
		return this.#events.onCredentialDisabled(listener);
	}

	/**
	 * Subscribe to auth-death failover notices. Returns an unsubscribe handle.
	 *
	 * Listener faults are isolated exactly as they are for disable events: a subscriber that
	 * throws must not break the rotation that is trying to keep the request alive.
	 */
	onCredentialFailover(listener: (event: CredentialFailoverEvent) => void | Promise<void>): () => void {
		return this.#events.onCredentialFailover(listener);
	}

	/**
	 * Subscribe to withheld-quota notices (quota exhausted, siblings idle, balancing off).
	 * Returns an unsubscribe handle. Listener faults are isolated like every other notice here.
	 */
	onUsageLimitWithheld(listener: (event: UsageLimitWithheldEvent) => void | Promise<void>): () => void {
		return this.#events.onUsageLimitWithheld(listener);
	}

	/**
	 * The label a notice uses for an account: the operator's own name for it when they set one,
	 * else the identity the account list shows, else the row id. Never a token or a secret.
	 */
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

	/** Whether exhaustion-driven movement between accounts is allowed right now. */
	#loadBalancingEnabled(): boolean {
		const setting = this.#loadBalancing;
		return typeof setting === "function" ? setting() : setting;
	}

	/**
	 * Set a runtime API key override (not persisted to disk).
	 * Used for CLI --api-key flag.
	 */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.#runtimeOverrides.set(provider, apiKey);
	}

	/**
	 * Remove a runtime API key override.
	 */
	removeRuntimeApiKey(provider: string): void {
		this.#runtimeOverrides.delete(provider);
	}

	/**
	 * Register a per-provider API key sourced from user configuration
	 * (e.g. `models.yml` `providers.<name>.apiKey`). Higher priority than
	 * stored credentials and OAuth tokens — when the user pins a key in
	 * config, that key is what authenticates outbound requests, regardless
	 * of whatever the broker happens to have loaded for that provider.
	 *
	 * Lower priority than {@link setRuntimeApiKey} so a CLI `--api-key`
	 * still wins for the duration of a single invocation.
	 */
	setConfigApiKey(provider: string, apiKey: string): void {
		this.#configOverrides.set(provider, apiKey);
	}

	/**
	 * Remove a single config-sourced API key override.
	 */
	removeConfigApiKey(provider: string): void {
		this.#configOverrides.delete(provider);
	}

	/**
	 * Drop every config-sourced API key. Called by `ModelRegistry` before
	 * re-parsing `models.yml` so removed entries actually disappear.
	 */
	clearConfigApiKeys(): void {
		this.#configOverrides.clear();
	}

	/**
	 * Set a fallback resolver for API keys not found in storage or env vars.
	 * Used for custom provider keys from models.json.
	 */
	setFallbackResolver(resolver: (provider: string) => string | undefined): void {
		this.#fallbackResolver = resolver;
	}

	/**
	 * Reload credentials from storage.
	 */
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

	/**
	 * Gets cached credentials for a provider.
	 * @param provider - Provider name (e.g., "anthropic", "openai")
	 * @returns Array of stored credentials, empty if none exist
	 */
	#getStoredCredentials(provider: string): StoredCredential[] {
		return this.#data.get(provider) ?? [];
	}

	/**
	 * Updates in-memory credential cache for a provider.
	 * Removes the provider entry entirely if credentials array is empty.
	 * @param provider - Provider name (e.g., "anthropic", "openai")
	 * @param credentials - Array of stored credentials to cache
	 */
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
		this.#events.bumpGeneration("credentials");
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
			const identityKey = resolveOAuthDedupeIdentityKey(provider, credential);
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

	/** Returns all credentials for a provider as an array */
	#getCredentialsForProvider(provider: string): AuthCredential[] {
		return this.#getStoredCredentials(provider).map(entry => entry.credential);
	}

	/**
	 * Returns next index in round-robin sequence for load distribution.
	 * Increments stored counter and wraps at total.
	 */
	#getNextRoundRobinIndex(providerKey: string, total: number): number {
		if (total <= 1) return 0;
		const current = this.#providerRoundRobinIndex.get(providerKey) ?? -1;
		const next = (current + 1) % total;
		this.#providerRoundRobinIndex.set(providerKey, next);
		return next;
	}

	/**
	 * Returns credential indices in priority order for selection.
	 *
	 * With account movement ON: a session starts from a hash of its id (consistent per session) and
	 * a sessionless caller from the round-robin cursor, wrapping so every credential is tried.
	 *
	 * With account movement OFF: storage order, always. The hash and the cursor exist only to
	 * spread work across accounts, which is the move the setting forbids: a session that starts on
	 * whichever account its id hashes to, or a sessionless caller that advances a cursor, has
	 * already been balanced before any block or ranking is consulted. Off means one account per
	 * provider and type serves until the operator chooses another.
	 */
	#getCredentialOrder(providerKey: string, sessionId: string | undefined, total: number): number[] {
		if (total <= 1) return [0];
		if (!this.#loadBalancingEnabled()) return Array.from({ length: total }, (_, i) => i);
		const start = sessionId ? getHashedIndex(sessionId, total) : this.#getNextRoundRobinIndex(providerKey, total);
		const order: number[] = [];
		for (let i = 0; i < total; i++) {
			order.push((start + i) % total);
		}
		return order;
	}

	/**
	 * When a credential's temporary block expires, or `undefined` if it is not
	 * blocked for the given scope. Resolves the same way the selector does: the
	 * in-memory and persisted copies of both the global and the scoped block are
	 * consulted and the LATEST deadline wins.
	 *
	 * Public because "why is this account being skipped?" is a question the
	 * doctor and status surfaces have to answer, and because the resolution rule
	 * is subtle enough that a second implementation would drift from this one.
	 * `credentialIndex` is the position in {@link listOAuthAccounts}.
	 */
	credentialBlockedUntil(
		provider: string,
		providerKey: string,
		credentialIndex: number,
		blockScope?: string,
	): number | undefined {
		return this.#blocks.getCredentialBlockedUntil(provider, providerKey, credentialIndex, blockScope);
	}

	/** Records which credential was used for a session (for rate-limit switching). */
	#recordSessionCredential(
		provider: string,
		sessionId: string | undefined,
		type: AuthCredential["type"],
		index: number,
	): void {
		const credentialId = this.#getStoredCredentials(provider)[index]?.id;
		// Drained BEFORE the sessionId guard: a sessionless caller still moves accounts, and a
		// notice the operator never sees is the failure this event exists to fix.
		if (credentialId !== undefined) this.#drainPendingFailover(provider, credentialId);
		this.#routing.recordSessionCredential(provider, sessionId, type, index, credentialId);
	}

	/**
	 * Emit the auth-death notice at the moment the move is a FACT, not when it was predicted.
	 *
	 * `rotateSessionCredential` knows the account that died but not the account that will take
	 * over: ranking picks that on the next resolve, and with several healthy siblings a guess
	 * would name the wrong one. So the dying account is parked here and the notice fires from the
	 * resolve that actually served, which is the only place both names are true.
	 *
	 * Landing back on the SAME account (a refresh healed it) drains the entry silently: nothing
	 * moved, so there is nothing to report.
	 */
	#drainPendingFailover(provider: string, servedCredentialId: number): void {
		const pending = this.#pendingFailover.get(provider);
		if (!pending) return;
		this.#pendingFailover.delete(provider);
		if (pending.from.credentialId === servedCredentialId) return;
		// A notice describes the request in flight. If nothing resolved inside the window the
		// rotation was abandoned, and announcing it now would describe a move that never happened.
		if (Date.now() - pending.at > FAILOVER_NOTICE_WINDOW_MS) return;
		this.#events.emitCredentialFailover({
			provider,
			from: pending.from,
			to: { credentialId: servedCredentialId, label: this.#accountNoticeLabel(provider, servedCredentialId) },
			cause: pending.cause,
		});
	}

	/**
	 * Route this session's requests for one provider to one specific credential.
	 *
	 * PER PROVIDER, deliberately. Several providers serve one session at the same time
	 * (the main model, agent roles, web search), so there is no single "current
	 * account" to switch: pinning Anthropic must leave the Codex and Gemini routing
	 * exactly as it was. Cross-provider movement is a MODEL choice, not an account one.
	 *
	 * Returns false when `credentialId` is not a live credential of `provider`, so a
	 * caller cannot record a pin that would silently resolve to nothing.
	 */
	pinSessionCredential(provider: string, sessionId: string | undefined, credentialId: number): boolean {
		return this.#routing.pinSessionCredential(provider, sessionId, credentialId);
	}

	/** Forget an explicit account choice; routing returns to its own selection. */
	clearSessionCredentialPin(provider: string, sessionId: string | undefined): void {
		this.#routing.clearSessionCredentialPin(provider, sessionId);
	}

	/** The credential id the user chose for a provider, or undefined when they never chose. */
	selectedProviderCredentialId(provider: string): number | undefined {
		return this.#routing.getSelectedCredential(provider)?.credentialId;
	}

	/**
	 * Index of the account explicitly chosen for this provider, when it is of `type`.
	 *
	 * A session pin outranks the global selection: it is the more recent statement of the same kind
	 * of thing. Both outrank everything automatic, whatever `accounts.loadBalancing` says — the
	 * setting governs what the product does on its own initiative, never what a caller is
	 * allowed to ask for. Sticky routing is deliberately NOT a choice: it records which account
	 * happened to serve last, which is the product's doing and not a statement by anybody.
	 *
	 * A pin naming another credential type answers `undefined` rather than deferring to the global
	 * selection, because the pin is the operative choice and the type asked about simply is not it.
	 *
	 * An account whose grant failed authentication answers `undefined` too. Honouring a choice means
	 * letting the provider decide, and for a revoked grant the provider already has: holding the
	 * request on it would strand the session rather than serve it. A quota hold is the opposite case
	 * and never lands here — see {@link #authDeadCredentials}.
	 */
	#explicitChoiceIndex(
		provider: string,
		sessionId: string | undefined,
		type: AuthCredential["type"],
	): number | undefined {
		const pinned = this.#routing.getSessionCredentialPin(provider, sessionId);
		const chosen = pinned ?? this.#routing.getSelectedCredential(provider);
		if (chosen?.type !== type) return undefined;
		const credentialId = this.#getStoredCredentials(provider)[chosen.index]?.id;
		if (credentialId !== undefined && this.#authDeadCredentials.has(credentialId)) return undefined;
		return chosen.index;
	}

	/**
	 * Index of the account that leads selection for this provider and type before any automatic
	 * ordering: the explicit choice when one exists, else — only while account movement is OFF —
	 * the account this session last used.
	 *
	 * With movement off the sticky record is promoted to the rank of a choice because there is
	 * nothing else that may decide: a hold on that account is a reason to wait, not a reason to
	 * spend a sibling, so it keeps leading while blocked, exactly as a pin does. With movement on
	 * the sticky record stays an observation and the ordering below decides, so this answers only
	 * the explicit choice.
	 *
	 * A sticky account whose grant failed authentication is skipped for the same reason a chosen
	 * one is: the provider has refused it, and holding the request on it would strand the session.
	 */
	#homeIndex(provider: string, sessionId: string | undefined, type: AuthCredential["type"]): number | undefined {
		const chosen = this.#explicitChoiceIndex(provider, sessionId, type);
		if (chosen !== undefined || this.#loadBalancingEnabled()) return chosen;
		const sticky = this.#routing.getStickySessionCredential(provider, sessionId);
		if (sticky?.type !== type) return undefined;
		const credentialId = this.#getStoredCredentials(provider)[sticky.index]?.id;
		if (credentialId === undefined || this.#authDeadCredentials.has(credentialId)) return undefined;
		return sticky.index;
	}

	/**
	 * Choose the account a provider uses, for every session and every profile on this machine.
	 *
	 * GLOBAL, not session-scoped, because the credentials are: they live in one shared database
	 * that every profile reads, so a choice recorded per session evaporates on the next `veyyon`
	 * and a choice recorded per profile would disagree with the account list it was made from.
	 *
	 * PER PROVIDER, deliberately. Several providers serve one session at the same time (the main
	 * model, agent roles, web search), so there is no single "current account" to switch:
	 * choosing an Anthropic account must leave Codex and Gemini exactly as they were.
	 *
	 * The session's sticky routing record is dropped as part of the same call, so the next resolve
	 * re-ranks from the choice instead of reusing whatever served the previous request. Without
	 * that the card would show the newly chosen account while the old one kept serving.
	 *
	 * Returns false when `credentialId` is not a live credential of `provider`, so a caller cannot
	 * record a choice that would resolve to nothing.
	 */
	selectProviderCredential(provider: string, credentialId: number, options?: { sessionId?: string }): boolean {
		return this.#routing.selectProviderCredential(provider, credentialId, options?.sessionId);
	}

	/** Forget the global choice for a provider; routing returns to its own selection. */
	clearProviderSelection(provider: string, options?: { sessionId?: string }): void {
		this.#routing.clearProviderSelection(provider, options?.sessionId);
	}

	/**
	 * What this session is routed to for one provider, and whether that matches what the
	 * user asked for.
	 *
	 * `selectedCredentialId` is the user's choice; `activeCredentialId` is what will actually
	 * serve the next request. They differ when the pinned account is blocked or was rotated
	 * away from, and reporting that difference is the whole reason this returns both:
	 * showing only the active account would present a rate-limit rotation as if the user
	 * had chosen it, and showing only the pin would claim an account is serving traffic
	 * that is not.
	 */
	sessionCredentialRouting(provider: string, sessionId: string | undefined): SessionCredentialRouting | undefined {
		// No `!sessionId` early return: `selectedCredentialId` now reports the GLOBAL selection when
		// no session pin exists, and that fact is true with or without a session. Bailing here left
		// every sessionless surface — a one-shot CLI, the account card built for a test — unable to
		// see which account the user chose.
		const stored = this.#getStoredCredentials(provider);
		if (stored.length === 0) return undefined;
		const routing: SessionCredentialRouting = { provider };
		const pin = this.#routing.getSessionCredentialPin(provider, sessionId);
		// The LAST-USED record, never `getSessionCredential`: that one answers with the pin,
		// so asking it here made `activeCredentialId` a copy of `selectedCredentialId` and the
		// divergence this method exists to report could never be observed.
		const sticky = this.#routing.getStickySessionCredential(provider, sessionId);
		const stickyEntry = sticky ? stored[sticky.index] : undefined;
		if (pin) {
			routing.selectedCredentialId = pin.credentialId;
			// `${provider}:${type}`, the same composite `getProviderTypeKey` builds. Passing the
			// bare credential type looked plausible and silently matched no block row at all, so
			// a blocked pin reported itself as healthy.
			const blockedUntil = this.credentialBlockedUntil(
				provider,
				getProviderTypeKey(provider, stored[pin.index]!.credential.type),
				pin.index,
			);
			if (blockedUntil !== undefined) routing.selectedBlockedUntilMs = blockedUntil;
			// A hold no longer moves traffic off an explicitly chosen account, so a held pin IS what
			// serves next and says so as an observation, with its deadline alongside. The one exception
			// is a pin whose grant failed authentication: `#explicitChoiceIndex` drops that one, because
			// the provider has already refused it, and the cascade below reports the substitute as the
			// prediction it is.
			const choiceStillLeads =
				this.#explicitChoiceIndex(provider, sessionId, stored[pin.index]!.credential.type) === pin.index;
			if (choiceStillLeads) {
				routing.activeCredentialId = pin.credentialId;
				return routing;
			}
		}
		// A sticky record is an OBSERVATION and outranks a prediction, but only while the credential
		// it names can still serve: a blocked one answers "where your traffic went", not "where the
		// next request goes", and those are different questions on a card that only asks the second.
		// With account movement off the two questions have one answer: nothing may move the session
		// off the account it used, so a blocked sticky account IS what serves next, and it waits.
		if (
			sticky &&
			stickyEntry &&
			(!this.#loadBalancingEnabled() || this.#credentialUsableNow(provider, stickyEntry, sticky.index)) &&
			!this.#authDeadCredentials.has(stickyEntry.id)
		) {
			routing.activeCredentialId = stickyEntry.id;
			return routing;
		}
		const predicted = this.#predictNextCredentialId(provider, sessionId);
		if (predicted !== undefined) {
			routing.activeCredentialId = predicted;
			routing.activeIsPrediction = true;
			return routing;
		}
		// The cascade recognised no credential type here, which leaves the last-used one as the only
		// account with any claim on the next request, blocked or not.
		if (stickyEntry) routing.activeCredentialId = stickyEntry.id;
		return routing;
	}

	/** Whether one stored credential is free of a live rate-limit block right now. */
	#credentialUsableNow(provider: string, entry: StoredCredential, index: number): boolean {
		const providerKey = getProviderTypeKey(provider, entry.credential.type);
		return this.credentialBlockedUntil(provider, providerKey, index) === undefined;
	}

	/**
	 * Which credential the next request for this provider would pick, WITHOUT moving anything.
	 *
	 * PURE BY CONSTRUCTION, and that is the whole difficulty. The real selector reaches
	 * `#getCredentialOrder`, which calls `#getNextRoundRobinIndex` for a sessionless caller and
	 * ADVANCES the stored cursor as it answers. Predicting through it would mean that merely
	 * looking at the account list, or rendering a status chip on a repaint, moved the next request
	 * onto a different account: a display that changes the thing it reports. This reproduces the
	 * same arithmetic and stores nothing, so a hundred renders predict the same account and the
	 * request that eventually goes out is the one that advances the cursor.
	 *
	 * Covers the deterministic half of selection: the credential-type cascade (a login before a
	 * stored key, as `#resolveProviderApiKey` does it), session stickiness, and rate-limit ordering
	 * through {@link #orderByBlockAvailability}. It does NOT run an async usage-ranking strategy or
	 * a refresh, so a provider that ranks by remaining quota can still land elsewhere. Callers mark
	 * the answer as a prediction for exactly that reason.
	 */
	#predictNextCredentialId(provider: string, sessionId: string | undefined): number | undefined {
		const stored = this.#getStoredCredentials(provider);
		if (stored.length === 0) return undefined;
		// The answer when every account of every type has been refused. A surface asking this question
		// needs a name for the next request whatever state the accounts are in, and reporting nothing
		// would read as "no accounts" on a provider that has several.
		let refused: number | undefined;
		for (const type of ["oauth", "api_key"] as const) {
			const candidates = stored
				.map((entry, index) => ({ entry, index }))
				.filter(candidate => candidate.entry.credential.type === type);
			if (candidates.length === 0) continue;
			const providerKey = getProviderTypeKey(provider, type);
			// The same arithmetic `#getCredentialOrder` runs, without advancing the cursor. With
			// movement off there is no arithmetic: storage order, as the selector uses.
			const start = !this.#loadBalancingEnabled()
				? 0
				: sessionId
					? getHashedIndex(sessionId, candidates.length)
					: ((((this.#providerRoundRobinIndex.get(providerKey) ?? -1) + 1) % candidates.length) +
							candidates.length) %
						candidates.length;
			const rotated = candidates.map((_, offset) => candidates[(start + offset) % candidates.length]!);
			// No choice promotion here, and none is missing: `sessionCredentialRouting` answers with the
			// explicit choice (pin, else provider selection) and returns before it ever asks for a
			// prediction, so every path that reaches this line has no live choice to promote.
			const ordered = this.#orderByBlockAvailability(provider, providerKey, rotated);
			// A grant the provider REFUSED is not a candidate, and a block is not the same fact: a hold
			// is this product's prediction about a working account, while a refusal is the provider's
			// verdict about the grant itself. Availability ordering only knows about holds, so a dead
			// account sorted first and every surface reading this answered with it — the account card
			// naming a revoked grant as what serves next, and the first request of a session going to
			// the one account already known to refuse it. A type whose every candidate was refused is
			// skipped in favour of the next type, which is what the real cascade does when an OAuth
			// resolve fails and a stored key is sitting behind it.
			const chosen = ordered.find(candidate => !this.#authDeadCredentials.has(candidate.entry.id));
			if (chosen) return chosen.entry.id;
			refused ??= ordered[0]?.entry.id;
		}
		return refused;
	}

	/**
	 * The name a user gave one account, or undefined when they never set one.
	 *
	 * A missing name is NOT an error and must not be papered over with a provider label:
	 * callers fall back to the account's own identity (email, then org, then account id)
	 * so the row always says WHICH account it is, and the absence of a name stays visible
	 * as an invitation to set one.
	 */
	getAccountName(provider: string, credentialId: number): string | undefined {
		const read = this.#store.getAccountName;
		if (!read) return undefined;
		const row = this.#getStoredCredentials(provider).find(entry => entry.id === credentialId);
		if (!row) return undefined;
		return read.call(this.#store, resolveAccountNameIdentity(provider, row));
	}

	/**
	 * Name an account, or clear the name with an empty string.
	 *
	 * Writes to the names table, never to `auth_credentials`, so renaming an account
	 * cannot rewrite, reorder or truncate the token bytes it is named after. That is the
	 * property worth having: a rename is the one credential operation a user will do
	 * casually and repeatedly, and it must be incapable of costing them a login.
	 *
	 * Returns false when the store keeps no names (the remote broker) or the credential is
	 * unknown, so the caller can tell the user instead of reporting a save that did not happen.
	 */
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

	/**
	 * Selects a credential of the specified type for a provider.
	 * Returns both the credential and its index in the original array (for updates/removal).
	 * Uses deterministic hashing for session stickiness and skips blocked credentials when possible.
	 */
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

		const providerKey = getProviderTypeKey(provider, type);
		const order = this.#getCredentialOrder(providerKey, sessionId, credentials.length);
		const ordered = leadWithChosenAccount(
			this.#orderByBlockAvailability(
				provider,
				providerKey,
				order.map(idx => credentials[idx]),
			),
			this.#homeIndex(provider, sessionId, type),
		);
		return ordered[0] ?? credentials[order[0]];
	}

	/**
	 * Order credential candidates so a usable account always precedes a blocked
	 * one, and blocked accounts precede each other by how soon they free up.
	 *
	 * Selection used to answer a single yes/no question — "is this one blocked?"
	 * — and fall back to the round-robin head when every answer was yes. Every
	 * answer IS yes whenever a provider-wide quota wall marks each account as its
	 * turn comes round, and the round-robin head is then whichever account
	 * happens to sort first, routinely the one just marked with the LONGEST
	 * window. Handing that one back means the next request is guaranteed to fail
	 * the same way, which is the immediate-repeat signature in the error
	 * telemetry. The soonest-unblocking account is the only choice where the wait
	 * has a defined end, and by the time the caller's backoff elapses it may
	 * already be usable.
	 *
	 * Unblocked candidates keep their incoming order, so session stickiness and
	 * round-robin fairness are untouched whenever any account is actually usable.
	 *
	 * An explicit choice is NOT handled here. Availability ordering has one job, deciding among
	 * accounts nobody named, and every path that feeds it promotes the choice afterwards:
	 * `leadWithChosenAccount` on the prediction and by-type paths, the lead insert in
	 * `#resolveOAuthSelection` (which also weighs a session preference and a plan requirement), and
	 * `#selectApiKeyCredential`, which returns the chosen entry outright. A second exemption inside
	 * the sort was one more owner of that rule which no behaviour could distinguish from its absence.
	 *
	 * With account movement OFF the incoming order is kept, except that a grant the provider REFUSED
	 * sorts last. Sorting a usable sibling ahead of a blocked account IS the move the setting
	 * forbids; the block is still recorded (so the account list can say when the window returns)
	 * and the caller waits for it. A refusal is a different fact: the provider's verdict on the
	 * grant itself, which no wait will lift, so an account behind it is the only one that can serve.
	 */
	#orderByBlockAvailability<C extends { index: number }>(
		provider: string,
		providerKey: string,
		candidates: readonly (C | undefined)[],
		blockScope?: string,
	): C[] {
		const present = candidates.filter((candidate): candidate is C => candidate !== undefined);
		if (!this.#loadBalancingEnabled()) {
			const stored = this.#getStoredCredentials(provider);
			const refused = (candidate: C): boolean => {
				const id = stored[candidate.index]?.id;
				return id !== undefined && this.#authDeadCredentials.has(id);
			};
			return [...present.filter(candidate => !refused(candidate)), ...present.filter(refused)];
		}
		return present
			.map((candidate, position) => ({
				candidate,
				position,
				// `0` sorts every usable account ahead of every blocked one, and a real expiry is a
				// future epoch, so the two ranges cannot collide.
				blockedUntil:
					this.#blocks.getCredentialBlockedUntil(provider, providerKey, candidate.index, blockScope) ?? 0,
			}))
			.sort((left, right) =>
				left.blockedUntil === right.blockedUntil
					? left.position - right.position
					: left.blockedUntil - right.blockedUntil,
			)
			.map(entry => entry.candidate);
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
		const usageTimeout = Math.max(5000, this.#usageRequestTimeoutMs * 1.5);
		const usagePromise: Promise<Array<UsageRankingResult<ApiKeyCredential> | null>> = Promise.all(
			args.order.map(async idx => {
				const selection = args.credentials[idx];
				if (!selection) return null;
				const blockedUntil = this.#blocks.getCredentialBlockedUntil(
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
				const blockedUntil = this.#blocks.getCredentialBlockedUntil(
					args.provider,
					args.providerKey,
					selection.index,
					args.blockScope,
				);
				return { selection, usage: null, usageChecked: false, blockedUntil };
			});
		});

		return this.#rankUsageResults(usageResults, args, "none", nowMs);
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

		const providerKey = getProviderTypeKey(provider, "api_key");
		const order = this.#getCredentialOrder(providerKey, sessionId, credentials.length);
		const fallback = credentials[order[0]];
		const strategy = this.#rankingStrategyResolver?.(provider);
		// An explicitly chosen account is not a candidate in a headroom contest, it is the answer.
		// Ranking exists to choose among accounts nobody named, so it never runs over a live choice —
		// with account movement on as much as off, since the setting governs the product's own
		// initiative and not what a caller may ask for. With movement off the account this session
		// last used has the same standing (see `#homeIndex`).
		const homeIndex = this.#homeIndex(provider, sessionId, "api_key");
		const home = homeIndex === undefined ? undefined : credentials.find(entry => entry.index === homeIndex);
		if (home) return home;
		// A headroom contest is a move by another name: whichever key has the most quota left wins,
		// so the key changes as usage shifts. With movement off it does not run; the first key in
		// storage order serves until the operator chooses another.
		if (!strategy || !this.#loadBalancingEnabled()) {
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

	/**
	 * Clears round-robin and session assignment state for a provider.
	 * Called when credentials are added/removed to prevent stale index references.
	 */
	#resetProviderAssignments(provider: string): void {
		for (const key of this.#providerRoundRobinIndex.keys()) {
			if (key.startsWith(`${provider}:`)) {
				this.#providerRoundRobinIndex.delete(key);
			}
		}
		this.#routing.clearProviderSessionCredentials(provider);
		this.#blocks.clearProviderBlocks(provider);
	}

	/** Updates credential at index in-place (used for OAuth token refresh) */
	#replaceCredentialAt(provider: string, index: number, credential: AuthCredential): void {
		const entries = this.#getStoredCredentials(provider);
		if (index < 0 || index >= entries.length) return;
		const target = entries[index];
		this.#store.updateAuthCredential(target.id, credential);
		// Fresh bytes for this row mean a refresh or a re-login just worked, which retires the
		// auth-death mark: the grant the mark described is not the grant this row now holds, and the
		// an explicit choice of this account becomes honourable again.
		this.#authDeadCredentials.delete(target.id);
		const updated = [...entries];
		updated[index] = { id: target.id, credential };
		this.#setStoredCredentials(provider, updated);
	}

	/**
	 * CAS-style disable used when OAuth refresh definitively fails: only disables
	 * persisted `data` still matches the credential we attempted to refresh.
	 * Returns `false` when a peer rotated the row between our pre-check and the
	 * disable, so the caller can reload and retry instead of clobbering the
	 * freshly-rotated credential.
	 */
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
		this.#events.emitCredentialDisabled({ provider, disabledCause });
		return true;
	}

	/**
	 * Persist a SUCCESSFULLY REFRESHED credential by id, healing a row that a peer
	 * disabled while our refresh was in flight.
	 *
	 * This is the write that closes the "logged out after a rebuild" loop. Two
	 * processes sharing the credential store can refresh the same credential at
	 * once; providers that rotate the refresh token on every use hand one process
	 * the new token and the other an `invalid_grant`, and the loser CAS-disables the
	 * row it still believes is current. The winner then persists a perfectly LIVE
	 * token onto a row flagged disabled, `listAuthCredentials` filters it out, and
	 * the user sees a logout with a working token sitting on disk.
	 *
	 * A successful refresh is proof the grant is alive, so the row is re-enabled as
	 * part of the same write. The guard below is what keeps that from being
	 * dangerous: only a row disabled BY A REFRESH FAILURE may be healed. A row
	 * disabled by a logout, a revocation, or supersession by a newer duplicate stays
	 * disabled, because a successful refresh says nothing about the user's intent to
	 * have that row back. Resurrecting those was a real regression introduced by an
	 * earlier, unconditional version of this heal.
	 *
	 * Returns the row's current index, or -1 when the row is gone or must not be
	 * resurrected.
	 */
	#persistRefreshedCredentialById(provider: string, id: number, credential: AuthCredential): number {
		const readById = this.#store.readAuthCredentialById?.bind(this.#store);
		if (readById) {
			const latest = readById(id);
			// Gone entirely: nothing to heal, and recreating it would resurrect a
			// credential the store no longer has.
			if (!latest) return -1;
			// Disabled for a reason a refresh cannot disprove.
			if (!isRefreshFailureDisableCause(latest.disabledCause)) return -1;
		}

		// Skip a write that would change nothing. The rotation is now committed inside
		// the refresh single-flight (so an aborted caller cannot lose it), and the call
		// site that awaited the same refresh then asks to persist the identical
		// credential. Writing twice is pure redundant IO on the startup path, and it
		// makes every observer of the store see a spurious second update.
		// Prefer the store's own view when it can be read by id; fall back to the
		// in-memory entry, which both the single-flight commit and the call site keep
		// up to date, so stores without a by-id reader still avoid the double write.
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

		// The row may be absent from the in-memory list precisely because it was
		// disabled, so rebuild the entry from the store rather than requiring it to
		// already be present.
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
		const updated = [...entries];
		updated[index] = { id, credential };
		this.#setStoredCredentials(provider, updated);
		return index;
	}

	/**
	 * CAS-disable the row with `id`, but only if its persisted credential still
	 * matches `expected` — i.e. no peer/login rotated it while we refreshed.
	 * Addresses the row by id (re-resolved here, then matched on `data` in the
	 * store) so a concurrent reorder can't tear down the wrong credential.
	 */
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

	/**
	 * Get credential for a provider (first entry if multiple).
	 */
	get(provider: string): AuthCredential | undefined {
		return this.#getCredentialsForProvider(provider)[0];
	}

	/**
	 * Set credential for a provider.
	 */
	async set(provider: string, credential: AuthCredentialEntry): Promise<void> {
		const normalized = Array.isArray(credential) ? credential : [credential];
		const deduped = dedupeOAuthCredentials(provider, normalized);
		const stored = this.#store.replaceAuthCredentialsRemote
			? await this.#store.replaceAuthCredentialsRemote(provider, deduped)
			: this.#store.replaceAuthCredentialsForProvider(provider, deduped);
		this.#setStoredCredentials(
			provider,
			stored.map(record => ({ id: record.id, credential: record.credential })),
		);
		this.#resetProviderAssignments(provider);
	}

	/**
	 * List stored credential rows, optionally filtered by provider.
	 */
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

	/**
	 * Refresh one stored OAuth credential under durable row ownership.
	 */
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
		// One re-read of the provider's rows, settled early when there is nothing to refresh. Read
		// before the lease is taken and again after it, since a peer may rotate the row in between.
		const readRefreshCandidate = ():
			| { settled: StoredOAuthRefreshResult<T> }
			| { settled?: undefined; rows: StoredAuthCredential[]; row: StoredAuthCredential; current: T } => {
			const rows = this.#store.listAuthCredentials(provider);
			this.#setStoredCredentials(
				provider,
				rows.map(row => ({ id: row.id, credential: row.credential })),
			);
			const row = rows.find(entry => entry.credential.type === "oauth");
			if (row?.credential.type !== "oauth") {
				return { settled: { credential: undefined, refreshed: false, removed: false } };
			}
			const current = options.credentialFromRow(row.credential);
			if (!current) {
				return { settled: { credential: undefined, refreshed: false, removed: false } };
			}
			if (options.observedCredential && !authCredentialEquals(current, options.observedCredential)) {
				return { settled: { credential: current, refreshed: false, removed: false } };
			}
			if (!options.forceRefresh && Date.now() + refreshSkewMs < current.expires) {
				return { settled: { credential: current, refreshed: false, removed: false } };
			}
			if (options.canRefresh && !options.canRefresh(current)) {
				return { settled: { credential: current, refreshed: false, removed: false } };
			}
			return { rows, row, current };
		};

		while (hasDurableLease) {
			if (options.signal?.aborted) throw new AIError.RequestAbortError("OAuth refresh ownership aborted by caller");
			const candidate = readRefreshCandidate();
			if (candidate.settled !== undefined) return candidate.settled;
			const { row } = candidate;
			if (this.#store.tryAcquireCredentialRefreshLease?.(row.id, owner, Date.now() + OAUTH_REFRESH_LEASE_TTL_MS)) {
				leasedCredentialId = row.id;
				break;
			}
			const leaseExpiresAt = this.#store.getCredentialRefreshLeaseExpiresAt?.(row.id);
			const waitMs =
				leaseExpiresAt === undefined
					? OAUTH_REFRESH_LEASE_POLL_MS
					: clamp(leaseExpiresAt - Date.now(), OAUTH_REFRESH_LEASE_POLL_MS, 250);
			await raceWithSignal(Bun.sleep(waitMs), options.signal, "OAuth refresh ownership wait aborted by caller");
		}

		try {
			const candidate = readRefreshCandidate();
			if (candidate.settled !== undefined) return candidate.settled;
			const { rows, row, current } = candidate;
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

			// Either the rotated credentials, or a finished answer the failure handling
			// below produced (a disabled row, a kept credential, a re-read). The refresh
			// runs inside the shared lease-renewal helper, so the union is what crosses
			// that boundary before this function can return.
			type RefreshStep =
				| { kind: "refreshed"; credentials: OAuthCredentials }
				| { kind: "done"; result: StoredOAuthRefreshResult<T> };
			let step: RefreshStep;
			let leaseRenewalError: unknown;
			try {
				({ result: step, ownershipLost: leaseRenewalError } =
					await this.#refresher.withRefreshLeaseRenewal<RefreshStep>(leasedCredentialId, owner, async () => {
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
									this.#events.emitCredentialDisabled({ provider, disabledCause });
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
					}));
			} finally {
				clearTimeout(refreshTimeout);
			}
			if (step.kind === "done") return step.result;
			const refreshed = step.credentials;
			// Losing the lease AFTER a successful refresh must NOT discard the rotation.
			// The provider has already invalidated the old token, so throwing here would
			// leave a dead token on disk and log the user out on the next run — the exact
			// failure the lease exists to prevent. Instead, drop the lease fence from the
			// persist and rely on the data CAS below, which still refuses to overwrite a
			// row a peer has moved forward.
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

	/** Returns the row the credential landed on, so a caller can name or select that account. */
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

	/**
	 * Remove credential for a provider.
	 */
	async remove(provider: string): Promise<void> {
		if (this.#store.deleteAuthCredentialsRemote) {
			await this.#store.deleteAuthCredentialsRemote(provider, "deleted by user");
		} else {
			this.#store.deleteAuthCredentialsForProvider(provider, "deleted by user");
		}
		this.#setStoredCredentials(provider, []);
		this.#resetProviderAssignments(provider);
	}

	/**
	 * Remove one stored credential for a provider.
	 */
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

	/**
	 * List all providers with credentials.
	 */
	list(): string[] {
		return [...this.#data.keys()];
	}

	/**
	 * Check if credentials exist for a provider in storage.
	 */
	has(provider: string): boolean {
		return this.#getCredentialsForProvider(provider).length > 0;
	}

	/**
	 * Why this provider's credential was disabled, if a failed refresh disabled it.
	 *
	 * Returns `undefined` when the provider has no disabled credential, or when the
	 * most recent one was disabled for a reason the user already knows about: a
	 * logout, or being superseded by a newer login. Only a refresh failure is
	 * something they did not do and have not been told about.
	 *
	 * This exists because a disabled credential is invisible everywhere else.
	 * `listAuthCredentials` filters disabled rows, so `hasAuth` reports false and a
	 * user whose login was torn down by a failed refresh gets the same message as
	 * one who never signed in. Telling someone to log in, without saying that the
	 * login they had was thrown away or why, is the silent logout in its final
	 * form: everything worked, nothing was reported, and the account is gone.
	 */
	disabledCredentialCause(provider: string): string | undefined {
		const listDisabled = this.#store.listDisabledAuthCredentials?.bind(this.#store);
		if (!listDisabled) return undefined;
		// Newest first, so the first row is the disable that is actually current.
		// An account that was removed and re-added leaves older disabled rows whose
		// causes the user already resolved.
		const [latest] = listDisabled(provider);
		if (!latest?.disabledCause) return undefined;
		return isRefreshFailureDisableCause(latest.disabledCause) ? latest.disabledCause : undefined;
	}

	/**
	 * WHICH account {@link AuthStorage.disabledCredentialCause} is about.
	 *
	 * The cause alone says a login for this provider died; it does not say whose.
	 * A provider with several accounts renders the note beside the accounts that
	 * still work, so an unattributed "a previous login was signed out … press a to
	 * sign in again" reads as a statement about the account it sits next to, and a
	 * working login is reported as needing a fresh sign-in. Live: the dead grant
	 * belonged to one Google account and the note rendered against a different one
	 * that was serving every request.
	 *
	 * Undefined when the credential carries nothing that names an account, which is
	 * the API-key case and the reason the note keeps its unattributed wording.
	 */
	disabledCredentialAccount(provider: string): string | undefined {
		const listDisabled = this.#store.listDisabledAuthCredentials?.bind(this.#store);
		if (!listDisabled) return undefined;
		const [latest] = listDisabled(provider);
		if (!latest?.disabledCause || !isRefreshFailureDisableCause(latest.disabledCause)) return undefined;
		const credential = latest.credential;
		if (credential.type !== "oauth") return undefined;
		return credential.email || credential.accountId || undefined;
	}

	/**
	 * Every provider whose latest credential was torn down by a FAILED REFRESH, with the cause.
	 *
	 * The per-provider {@link AuthStorage.disabledCredentialCause} can only answer for a provider you
	 * already know to ask about, and the case that matters most is the one where you do not: a
	 * provider whose ONLY login died has no active credential, so it appears in no list of stored
	 * accounts and there is nothing left to prompt the question. That is the silent logout in its
	 * final form, and this is the reader that makes it enumerable.
	 *
	 * Filtered to refresh failures for the same reason as the single-provider form: a logout or a
	 * superseded duplicate is a disable the user performed and already knows about, and resurrecting
	 * it as a warning would train them to ignore the warning that matters.
	 */
	listProvidersWithFailedRefresh(): Array<{ provider: string; cause: string }> {
		const listDisabled = this.#store.listDisabledAuthCredentials?.bind(this.#store);
		if (!listDisabled) return [];
		const seen = new Set<string>();
		const failures: Array<{ provider: string; cause: string }> = [];
		// Newest first, so the first row seen for a provider is the disable that is current; an
		// account removed and re-added leaves older rows whose causes the user already resolved.
		for (const row of listDisabled()) {
			if (seen.has(row.provider)) continue;
			seen.add(row.provider);
			if (row.disabledCause && isRefreshFailureDisableCause(row.disabledCause)) {
				failures.push({ provider: row.provider, cause: row.disabledCause });
			}
		}
		return failures;
	}

	/**
	 * Check if any form of auth is configured for a provider.
	 * Unlike getApiKey(), this doesn't refresh OAuth tokens.
	 */
	hasAuth(provider: string): boolean {
		if (this.#runtimeOverrides.has(provider)) return true;
		if (this.#configOverrides.has(provider)) return true;
		if (this.#getCredentialsForProvider(provider).length > 0) return true;
		if (getEnvApiKey(provider)) return true;
		if (this.#fallbackResolver?.(provider)) return true;
		return false;
	}

	/**
	 * True iff a dedicated, non-env credential source is configured for this
	 * provider — i.e. anything in the cascade EXCEPT `getEnvApiKey(provider)`.
	 *
	 * Mirrors `hasAuth` minus the env-fallback leg. Useful for callers that
	 * need to distinguish "the user explicitly configured this provider"
	 * from "an env var happens to alias this provider via the cross-provider
	 * fallback map" (see e.g. `xai-oauth → XAI_OAUTH_TOKEN || XAI_API_KEY` in
	 * `stream.ts`). Without that distinction, an `XAI_API_KEY`-only setup
	 * silently satisfies xai-oauth and routes around `providers.xai.baseUrl`.
	 */
	hasNonEnvCredential(provider: string): boolean {
		if (this.#runtimeOverrides.has(provider)) return true;
		if (this.#configOverrides.has(provider)) return true;
		if (this.#getCredentialsForProvider(provider).length > 0) return true;
		if (this.#fallbackResolver?.(provider)) return true;
		return false;
	}

	/**
	 * Classify where a provider's auth comes from, following the same precedence
	 * as {@link AuthStorage.getApiKey}: runtime override → config override →
	 * stored OAuth → login-stored api_key → env var → stored api_key →
	 * fallback resolver. Returns undefined when no auth is configured.
	 *
	 * Compact, structured counterpart to {@link describeCredentialSource}.
	 */
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

	/**
	 * Check if OAuth credentials are configured for a provider.
	 */
	hasOAuth(provider: string): boolean {
		return this.#getCredentialsForProvider(provider).some(credential => credential.type === "oauth");
	}

	/**
	 * Get OAuth credentials for a provider.
	 */
	getOAuthCredential(provider: string): OAuthCredential | undefined {
		return this.#getCredentialsForProvider(provider).find(
			(credential): credential is OAuthCredential => credential.type === "oauth",
		);
	}

	#resolveActiveOAuthCredential(provider: string, sessionId?: string): OAuthCredential | undefined {
		const allCredentials = this.#getCredentialsForProvider(provider);
		const oauthCredentials = allCredentials.filter((c): c is OAuthCredential => c.type === "oauth");
		if (oauthCredentials.length === 0) return undefined;

		// Runtime / config overrides bypass OAuth account_uuid attribution — the
		// caller is authenticating with an explicit key, not the broker's OAuth.
		if (this.#runtimeOverrides.has(provider) || this.#configOverrides.has(provider)) return undefined;

		// Prefer the session-sticky credential when available.
		const sessionPref = this.#routing.getSessionCredential(provider, sessionId);
		// If the session has been routed to a stored API key, do not inject OAuth account_uuid.
		if (sessionPref !== undefined && sessionPref.type !== "oauth") return undefined;

		// When no session-sticky credential is recorded yet (first call before any getApiKey,
		// or all stored credentials are unavailable), the request falls through to the env-key
		// or fallback-resolver path in getApiKey() — neither is OAuth-authenticated, so
		// account_uuid injection would misattribute traffic. Only apply this guard when
		// sessionPref is absent; a recorded OAuth sticky (sessionPref.type === "oauth") must
		// NOT be blocked even if an env key also happens to exist.
		if (!sessionPref && (getEnvApiKey(provider) || this.#fallbackResolver?.(provider))) return undefined;
		// Resolve the sticky index against the full credential list — the index is
		// recorded against the unfiltered provider array (by #recordSessionCredential /
		// #tryOAuthCredential), not the OAuth-only subset, so dereferencing it into the
		// filtered array would be off-by-N when any non-OAuth credential precedes the
		// OAuth ones (e.g. [api_key, oauth_A, oauth_B] stored order).
		const stickyCredential = sessionPref?.type === "oauth" ? allCredentials[sessionPref.index] : undefined;
		return stickyCredential?.type === "oauth" ? stickyCredential : oauthCredentials[0];
	}

	/**
	 * Get the OAuth `accountId` for a provider, preferring the credential that is
	 * session-sticky for `sessionId` when multiple OAuth credentials are configured.
	 * Falls back to the first OAuth credential when no session preference exists (e.g.
	 * first call before any `getApiKey` has been issued, or single-credential setups).
	 * Returns `undefined` when no OAuth credential carries an `accountId`.
	 */
	getOAuthAccountId(provider: string, sessionId?: string): string | undefined {
		const preferred = this.#resolveActiveOAuthCredential(provider, sessionId);
		const accountId = preferred?.accountId;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	}

	/**
	 * Get the OAuth account identity for a provider, preferring the credential that
	 * is session-sticky for `sessionId`. This is a read-only lookup for display and
	 * metadata paths; it does not refresh tokens, rank usage, or advance selection.
	 */
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

	/**
	 * Get all credentials.
	 */
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

	/**
	 * Login to an OAuth provider. Resolves with the stored credential's
	 * identity slice (or `undefined` when nothing was stored) so callers can
	 * surface which account — and for Anthropic, which organization — the
	 * login registered.
	 */
	async login(
		provider: OAuthProviderId,
		ctrl: OAuthController & {
			/** onAuth is required by auth-storage but optional in OAuthController */
			onAuth: (info: OAuthAuthInfo) => void;
			/**
			 * onPrompt is required for some providers (github-copilot, openai-codex). The parameter is
			 * the flow's own `OAuthPrompt`, restated here as a structural type rather than narrowed:
			 * spelling out two of its fields hid `secret` from every caller, so a UI reading this
			 * signature could not know an answer was a credential to be masked.
			 */
			onPrompt: (prompt: OAuthPrompt) => Promise<string>;
		},
	): Promise<OAuthLoginIdentity | undefined> {
		// Only paste-code providers (fixed non-loopback redirect, e.g. GitLab Duo
		// Agent's vscode:// URI) get a default manual-code prompt. For loopback OAuth
		// providers the `OAuthCallbackFlow` would otherwise race this readline prompt
		// against the HTTP callback and, when the callback wins, leave the prompt
		// outstanding — a dirty/blocked terminal. Synthesizing the default only for
		// paste-code providers is the authoritative gate (it covers every caller, not
		// just the CLI); an explicit caller-supplied `onManualCodeInput` is still
		// honored for any provider as an escape hatch.
		// The pasted answer is credential material: an authorization code, or a redirect URL carrying
		// one, and either is exchangeable for tokens. It is marked so no UI echoes it.
		const manualCodeInput = PASTE_CODE_LOGIN_PROVIDERS.has(provider)
			? () => ctrl.onPrompt({ message: "Paste the authorization code (or full redirect URL):", secret: true })
			: undefined;
		// Built-in registry first, then runtime-registered extension providers.
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
		// `storeCredentialsAs` applies to both shapes. A provider entry exists per
		// login MECHANISM, so one product can offer OAuth and a pasted key from two
		// entries; the credential still belongs to the product, and everything that
		// reads it — the model manager, the account card, the model list — resolves it
		// by the product's id alone. Honoring the redirection on the OAuth branch alone
		// filed the pasted key under the mechanism's id, where nothing looks for it.
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
		// Use #upsertOAuthCredential to upsert the new credential.
		// Any legacy api_key rows from older versions will be cleaned up so they do not
		// shadow the new OAuth row, while preserving other active OAuth credentials.
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

	/**
	 * Logout from a provider.
	 */
	async logout(provider: string): Promise<void> {
		await this.remove(provider);
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Usage API Integration
	// Queries provider usage endpoints to detect rate limits before they occur.
	// ─────────────────────────────────────────────────────────────────────────────

	/**
	 * Find the stored credential id matching a {@link UsageCredential} so the
	 * refresh override can address the row.
	 */
	#findStoredCredentialIdForUsageCredential(provider: Provider, previous: UsageCredential): number | undefined {
		return this.#getStoredCredentials(provider).find(isUsageCredentialRow(previous))?.id;
	}

	#persistRefreshedUsageCredential(provider: Provider, previous: UsageCredential, next: UsageCredential): void {
		const entries = this.#getStoredCredentials(provider);
		const index = entries.findIndex(isUsageCredentialRow(previous));
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
		// The scoped handle clears its backing timer once the probe settles
		// instead of leaving it armed like a bare AbortSignal.timeout.
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
			accountKey: buildUsageCacheIdentity(request.credential),
			signal: timeoutSignal,
		};

		if (
			request.credential.type === "oauth" &&
			request.credential.expiresAt !== undefined &&
			Date.now() + OAUTH_REFRESH_SKEW_MS >= request.credential.expiresAt
		) {
			const refreshableCredential = buildRefreshableOauthCredential(request.credential);
			if (refreshableCredential) {
				try {
					const refreshableCredentialId = this.#findStoredCredentialIdForUsageCredential(
						request.provider,
						request.credential,
					);
					const refreshed = await this.#refresher.refreshOAuthCredential(
						request.provider,
						refreshableCredential,
						refreshableCredentialId,
						timeoutSignal,
					);
					const refreshedCredential = mergeRefreshedUsageCredential(request.credential, refreshed);
					this.#persistRefreshedUsageCredential(request.provider, request.credential, refreshedCredential);
					params = {
						...request,
						credential: refreshedCredential,
						accountKey: buildUsageCacheIdentity(refreshedCredential),
						signal: timeoutSignal,
					};
				} catch (error) {
					const errorMsg = String(error);
					// Definitive failure (invalid_grant / 401 not from a network blip) means
					// the refresh token itself is dead — probing with the original credential
					// will 401, the catch below will return null, and #fetchUsageCached's
					// last-good fallback will surface yesterday's report indefinitely
					// (including its already-elapsed `resetsAt`). CAS-disable the row and
					// clear the cache so the credential drops out of the report instead of
					// freezing in place until the user notices and re-logs in.
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
									// Neutralize last-good for this cache key: write a null
									// entry with an immediately-elapsed expiry so a future
									// getStale lookup (e.g. on re-login under the same
									// account identity) can't replay the stale report.
									this.#usageCache.set(buildUsageReportCacheKey(request), {
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
			// Attribute the report to the credential's organization. The orgId and
			// orgName fallbacks apply independently: Claude's usage endpoint stamps
			// orgId from the `anthropic-organization-id` response header but never
			// carries a display name, so the stored name must still be attached.
			// Never attach the stored name over a DIFFERENT org's report.
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
		const cacheKey = buildUsageReportCacheKey(request);
		const now = Date.now();
		const cached = this.#usageCache.get<UsageReport | null>(cacheKey);
		// Fresh cache hit: return whatever's there (success or null fallback).
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
				// Success: stagger per-credential cache expiry so all accounts don't
				// refresh in the same window — Anthropic / OpenAI rate-limit `/usage`
				// per source IP regardless of account, and synchronized 5-credential
				// fan-out trips 429s every cycle. With ±25% jitter on TTL the refresh
				// times decorrelate within a few cycles.
				this.#usageCache.set(cacheKey, { value: report, expiresAt: Date.now() + USAGE_REPORT_TTL_MS + ttlJitter });
				this.#recordUsageHistory(request, report);
				this.#reconcileCodexUsageBlock(request, report);
				return report;
			}
			// Failure: apply a short jittered cool-down so the credential doesn't
			// re-hit the endpoint on every poll. Serve the last good value when we
			// have one (keeps the credential in the report); otherwise cache null
			// so a cold or throttled credential stops re-bursting until the window
			// expires and the next poll retries.
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

	/**
	 * Append a freshly fetched report to durable usage history (when the store
	 * supports it). The usage cache is latest-snapshot-only — these rows are
	 * the only place limit utilization is kept over time.
	 */
	#recordUsageHistory(request: UsageRequestDescriptor, report: UsageReport): void {
		const record = this.#store.recordUsageSnapshots;
		if (!record || report.limits.length === 0) return;
		const recordedAt = Number.isFinite(report.fetchedAt) && report.fetchedAt > 0 ? report.fetchedAt : Date.now();
		const accountKey = buildUsageCacheIdentity(request.credential);
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

	/**
	 * Recorded usage-limit snapshots, oldest first. Empty when the underlying
	 * store has no durable history (e.g. a broker-backed remote store).
	 */
	listUsageHistory(query?: UsageHistoryQuery): UsageHistoryEntry[] {
		return this.#store.listUsageHistory?.(query) ?? [];
	}

	/** Record one observed provider request cost for later local usage aggregation. */
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
			accountKey: buildUsageCacheIdentity(credential),
			costUsd,
		};
		try {
			record.call(this.#store, [entry]);
			const cacheKey = buildUsageReportCacheKey({
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
		const sessionCredential = this.#routing.getSessionCredential(provider, sessionId);
		if (sessionCredential) {
			const credential = entries[sessionCredential.index]?.credential;
			if (credential) {
				return credential.type === "api_key"
					? { type: "api_key", apiKey: credential.key }
					: buildUsageCredential(credential);
			}
		}
		if (entries.length === 1) {
			const credential = entries[0]!.credential;
			return credential.type === "api_key"
				? { type: "api_key", apiKey: credential.key }
				: buildUsageCredential(credential);
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

		const cacheKey = buildUsageReportCacheKey(buildUsageRequestForOauth(provider, credential, options?.baseUrl));
		const now = Date.now();
		const parsedReport = parseHeaders(headers, now);
		if (!parsedReport) return false;
		// Throttled to one ingest per interval — except when a window reads
		// exhausted: that snapshot must land immediately so the next getApiKey
		// blocks the credential instead of burning a wire 429 on the wall.
		const exhausted = parsedReport.limits.some(limit => isUsageLimitExhausted(limit));
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
		// Providers with no stored credential still need a request built, because a usage backend can
		// report a quota for an account the store has not seen yet. The set of them comes from the
		// registry rather than a local table; see `usage/registry.ts`.
		const providers = new Set<string>([
			...this.#data.keys(),
			...listRegisteredUsageProviders().map(provider => provider.id),
		]);

		for (const providerId of providers) {
			const provider = providerId as Provider;
			const providerImpl = resolver(provider);
			if (!providerImpl) continue;
			// The base URL resolver builds the provider's model list, so it is read only once a request is
			// built, never for a registered usage provider that holds no credential.
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
				const request = buildUsageRequest(
					provider,
					{ type: "api_key", apiKey },
					options?.baseUrlResolver?.(provider),
				);
				if (providerImpl.supports && !providerImpl.supports(request)) continue;
				requests.push(request);
				continue;
			}

			const baseUrl = options?.baseUrlResolver?.(provider);
			for (const entry of entries) {
				const credential = entry.credential;
				const request =
					credential.type === "api_key"
						? buildUsageRequest(provider, { type: "api_key", apiKey: credential.key }, baseUrl)
						: buildUsageRequestForOauth(provider, credential, baseUrl);
				if (providerImpl.supports && !providerImpl.supports(request)) continue;
				requests.push(request);
			}
		}

		return requests;
	}

	#dedupeUsageReports(reports: UsageReport[]): UsageReport[] {
		const groups: UsageReport[][] = [];
		const idToGroup = new Map<string, number>();

		for (const report of reports) {
			const identifiers = getUsageReportIdentifiers(report);
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

		const deduped = groups.map(group => mergeUsageReportGroup(group));
		if (deduped.length !== reports.length) {
			this.#usageLogger?.debug("Usage reports deduped", {
				before: reports.length,
				after: deduped.length,
			});
		}
		return deduped;
	}

	async #getUsageReport(
		provider: Provider,
		credential: AuthCredential,
		options?: { baseUrl?: string; timeoutMs?: number; signal?: AbortSignal },
	): Promise<UsageReport | null> {
		// Store-level hook (e.g. `RemoteAuthCredentialStore`) is authoritative
		// when present for OAuth: the broker already aggregates usage from a
		// less-throttled IP, and falling back to the local per-credential fetch
		// would defeat the point of routing through it. API-key credentials do
		// not have a broker per-credential hook, so they use the normal cached
		// provider fetch path.
		if (credential.type === "oauth") {
			const storeHook = this.#store.getUsageReport?.bind(this.#store);
			if (storeHook) {
				const report = await withAuthHttpConcurrency(() => storeHook(provider, credential, options?.signal));
				if (report) {
					this.#reconcileCodexUsageBlock(
						buildUsageRequestForOauth(provider, credential, options?.baseUrl),
						report,
					);
				}
				return report;
			}
		}
		const usageCredential = buildUsageCredential(credential);
		if (credential.type === "api_key") {
			const resolvedApiKey = await this.#configValueResolver(credential.key);
			if (!resolvedApiKey) return null;
			usageCredential.apiKey = resolvedApiKey;
		}
		return this.#fetchUsageCached(
			buildUsageRequest(provider, usageCredential, options?.baseUrl),
			options?.timeoutMs ?? this.#usageRequestTimeoutMs,
		);
	}

	/**
	 * The {@link UsageProvider} registered for `provider`, or undefined when the
	 * provider has no usage endpoint at all. Lets callers tell "a credential we
	 * could have fetched usage for but didn't" apart from "a provider with no
	 * usage concept" (web-search keys, local/keyless servers, inference
	 * providers without a usage API) — the latter never warrants a usage row.
	 */
	usageProviderFor(provider: Provider): UsageProvider | undefined {
		return this.#usageProviderResolver?.(provider);
	}

	async fetchUsageReports(options?: {
		baseUrlResolver?: (provider: Provider) => string | undefined;
		/** Caller's cancel signal; only rejects this caller, never the shared upstream fetch. */
		signal?: AbortSignal;
	}): Promise<UsageReport[] | null> {
		// Caller override > store-level hook > local per-credential fan-out.
		// `RemoteAuthCredentialStore` implements the store hook so a gateway
		// backed by a broker automatically routes usage to the broker without
		// needing the caller to wire it explicitly.
		const storeOverride = this.#store.fetchUsageReports?.bind(this.#store);
		const override = this.#fetchUsageReportsOverride ?? storeOverride;
		const shouldReconcileStoreHookReports =
			this.#fetchUsageReportsOverride === undefined && storeOverride !== undefined;
		if (override) {
			// Reuse the in-flight map so concurrent callers (widget poll + format
			// dispatch + credential selection) coalesce into one upstream call.
			// Each caller's `signal` only cancels THAT caller's await; the
			// shared upstream fetch runs to completion so peers aren't punished.
			const OVERRIDE_KEY = "__override__";
			let shared = this.#usageReportsInFlight.get(OVERRIDE_KEY);
			if (!shared) {
				// Don't forward the caller signal into the shared fetch — first caller's
				// abort would otherwise cancel the upstream for every peer.
				shared = withAuthHttpConcurrency(override).finally(() => {
					this.#usageReportsInFlight.delete(OVERRIDE_KEY);
				});
				this.#usageReportsInFlight.set(OVERRIDE_KEY, shared);
			}
			const reports = await raceWithSignal(shared, options?.signal, "usage fetch aborted");
			if (shouldReconcileStoreHookReports && reports) this.#reconcileCodexUsageBlocksFromReports(reports);
			return reports;
		}
		if (!this.#usageProviderResolver) return null;

		const requests = this.#collectUsageRequests(options);
		if (requests.length === 0) return [];

		this.#usageLogger?.debug("Usage fetch requested", {
			providers: [...new Set(requests.map(request => request.provider))].sort(),
		});

		// Per-credential caching with jitter lives in #fetchUsageCached, so we
		// don't store the aggregated result here — doing so locks the widget to
		// a single decorrelation snapshot for 30s, defeating the jitter (some
		// accounts can be missing from one fetch and present in the next; the
		// aggregate cache freezes whichever set landed first).
		const cacheKey = buildUsageReportsCacheKey(requests);

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
			// no outer cache write — see comment above.
			const resolved = deduped;
			this.#usageLogger?.debug("Usage fetch resolved", {
				reports: resolved.map(report => {
					const accountLabel =
						getUsageReportMetadataValue(report, "email") ??
						getUsageReportMetadataValue(report, "accountId") ??
						getUsageReportMetadataValue(report, "account") ??
						getUsageReportMetadataValue(report, "user") ??
						getUsageReportMetadataValue(report, "username") ??
						getUsageReportScopeAccountId(report);
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

	/**
	 * Probe each stored credential against its provider's auth-verifying usage
	 * endpoint and report per-credential auth health.
	 *
	 * Surfaces the identity of failing credentials so callers running a
	 * multi-account pool (e.g. a broker-backed auth-gateway) can tell which
	 * row is producing 401s. The probe mirrors the per-credential fan-out
	 * inside {@link AuthStorage.fetchUsageReports} (OAuth refresh-on-expiry,
	 * then `UsageProvider.fetchUsage`) but does NOT swallow errors — every
	 * credential gets either `ok: true`, `ok: false` with `reason`, or
	 * `ok: null` when no probe is configured for the provider.
	 *
	 * Iterates sequentially to avoid synchronized N-account fan-out that
	 * upstream `/usage` rate limiters (per source IP) treat as a burst.
	 *
	 * Only inspects active rows from {@link AuthCredentialStore.listAuthCredentials};
	 * soft-disabled rows are already known-bad and don't need a network probe.
	 * Environment-variable API keys are not enumerated — the caller's intent
	 * here is "which of my stored credentials is broken".
	 *
	 * Pass {@link CheckCredentialsOptions.completionProbe} to additionally
	 * exercise each credential against the provider's chat-completion endpoint
	 * (strict mode). The result lands on
	 * {@link CredentialHealthResult.completion}; the usage `ok` field is
	 * unchanged so callers can tell the two signals apart.
	 */
	async checkCredentials(options?: CheckCredentialsOptions): Promise<CredentialHealthResult[]> {
		options?.signal?.throwIfAborted();
		const active = this.#store.listAuthCredentials();
		// Filtered here rather than by the caller, so the per-row deadline, the refresh-on-expiry and
		// the sequential pacing below all apply unchanged to a one-row probe.
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
					? buildUsageRequest(row.provider as Provider, { type: "api_key", apiKey: cred.key }, baseUrl)
					: buildUsageRequestForOauth(row.provider as Provider, cred, baseUrl);

			// Scoped per-row deadline: cancelled at both loop exits below so the
			// backing timer never outlives the row's probes (a bare
			// AbortSignal.timeout stays armed for the full timeout). Every await
			// in between is individually try/caught, so the exits are exhaustive.
			const probeTimeout = scopedTimeoutSignal(timeoutMs, options?.signal);
			const probeSignal = probeTimeout.signal;
			let params: UsageFetchParams & { signal: AbortSignal } = {
				...initialRequest,
				accountKey: buildUsageCacheIdentity(initialRequest.credential),
				signal: probeSignal,
			};
			let refreshError: string | undefined;

			// Refresh expired OAuth before probing — without this an expired access
			// token reports as `false` when the credential is actually healthy
			// (broker would happily refresh it on the next real request). The
			// refreshed bytes feed BOTH the usage probe and the optional
			// completion probe; we do it up-front so it runs even when no
			// `UsageProvider` is registered for this provider.
			if (
				cred.type === "oauth" &&
				initialRequest.credential.type === "oauth" &&
				initialRequest.credential.expiresAt !== undefined &&
				Date.now() >= initialRequest.credential.expiresAt
			) {
				const refreshable = buildRefreshableOauthCredential(initialRequest.credential);
				if (refreshable) {
					try {
						const refreshed = await this.#refresher.refreshOAuthCredential(
							row.provider as Provider,
							refreshable,
							row.id,
							probeSignal,
						);
						const refreshedCredential = mergeRefreshedUsageCredential(initialRequest.credential, refreshed);
						this.#persistRefreshedUsageCredential(
							row.provider as Provider,
							initialRequest.credential,
							refreshedCredential,
						);
						params = {
							...params,
							credential: refreshedCredential,
							accountKey: buildUsageCacheIdentity(refreshedCredential),
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
				// The provider refused this grant, and that is the same verdict the request path records
				// when a turn dies on one. The mark belongs here too, because a probe is how a surface
				// learns of the refusal BEFORE any request is sent: without it the account card could
				// label a revoked grant as what serves next on the very row that printed the refusal,
				// and the session's first request was then guaranteed to fail on an account the product
				// had already been told about.
				this.#authDeadCredentials.add(row.id);
				// Refresh failed → the access token is unusable. Skip both probes;
				// they would only re-surface the same upstream failure.
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
						const accountId = getUsageReportMetadataValue(report, "accountId");
						const email = getUsageReportMetadataValue(report, "email");
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
				const probeCred = buildCompletionProbeCredential(params.credential);
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
		const sessionCredential = this.#routing.getSessionCredential(provider, sessionId);
		return sessionCredential ? { ...sessionCredential, explicit: false } : undefined;
	}

	/**
	 * Marks the current session's credential as temporarily blocked due to usage limits.
	 * Uses usage reports to determine accurate reset time when available.
	 * Returns whether a sibling credential is available now; when none is, also
	 * reports the earliest time a blocked sibling becomes available again so
	 * callers can wait for the sibling instead of the provider's full window.
	 */
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
			// Account quota survives OAuth bearer rotation. Attribute a delayed
			// usage-limit response through the durable row id captured when this
			// exact bearer was resolved; never use this alias for hard auth errors.
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

		const providerKey = getProviderTypeKey(provider, credentialType);
		const strategy = this.#rankingStrategyResolver?.(provider);
		const rankingContext: CredentialRankingContext = { modelId: options?.modelId };
		const blockScope = strategy?.blockScope?.(rankingContext);
		const now = Date.now();
		let blockedUntil = now + (options?.retryAfterMs ?? defaultBackoffMs);

		if (credentialType === "oauth" && target.credential.type === "oauth" && strategy) {
			const report = await this.#getUsageReport(provider, target.credential, options);
			if (report) {
				const scopedLimits = getScopedUsageLimits(strategy, report, rankingContext);
				if (isUsageLimitReached(scopedLimits)) {
					const resetAtMs = getUsageResetAtMs(scopedLimits, Date.now());
					if (resetAtMs && resetAtMs > blockedUntil) {
						blockedUntil = resetAtMs;
					}
				}
			}
		}

		// Usage lookup may refresh, disable, or remove a row. Re-resolve its
		// durable id before applying positional in-memory and persisted blocks.
		const targetIndex = this.#getStoredCredentials(provider).findIndex(
			entry => entry.id === targetCredentialId && entry.credential.type === credentialType,
		);
		if (targetIndex >= 0) {
			this.#blocks.markCredentialBlocked(provider, providerKey, targetIndex, blockedUntil, blockScope);
		}

		const siblings = this.#getCredentialsForProvider(provider)
			.map((credential, index) => ({ credential, index }))
			.filter(
				(entry): entry is { credential: AuthCredential; index: number } =>
					entry.credential.type === credentialType && entry.index !== targetIndex,
			);
		const siblingBlockedUntil = (index: number): number | undefined =>
			this.#blocks.getCredentialBlockedUntil(provider, providerKey, index, blockScope);

		if (!this.#loadBalancingEnabled()) {
			// The block above still stands: the window really is exhausted, and recording that is
			// what lets the account list say when it comes back. What load balancing gates is the
			// MOVE. With it off the caller waits for this account's own window instead of spending
			// a sibling that was never offered up, so `retryAtMs` is this account's reset —
			// never a sibling's, which is exactly the leak the gate exists to prevent.
			//
			// Idle siblings make that wait a CHOICE, and a choice nobody was told about cannot
			// be revisited, so the one moment the setting costs something is the one
			// moment it announces itself. Counted and announced here rather than at the call site
			// because the block scope and provider type key that decide "blocked" are private to
			// this class, and because the dedupe key is this window's own end.
			const idleSiblings = siblings.filter(candidate => siblingBlockedUntil(candidate.index) === undefined).length;
			if (idleSiblings > 0) {
				const noticeKey = `${provider}:${targetCredentialId}:${blockedUntil}`;
				if (!this.#withheldQuotaNotices.has(noticeKey)) {
					// Keys accumulate one per exhausted window per account. Drop the whole set past a
					// cap rather than tracking ages: the worst a cleared key costs is one repeated
					// notice, and a window that old has already reset.
					if (this.#withheldQuotaNotices.size >= MAX_WITHHELD_QUOTA_NOTICES) this.#withheldQuotaNotices.clear();
					this.#withheldQuotaNotices.add(noticeKey);
					this.#events.emitUsageLimitWithheld({
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

	/**
	 * Ranks fetched usage results in request order. A credential whose scoped limit is reached is
	 * blocked, and recorded as blocked, before its windows are scored. The plan requirement is the one
	 * axis on which API keys ("none") and OAuth accounts differ.
	 */
	#rankUsageResults<T extends AuthCredential>(
		usageResults: ReadonlyArray<UsageRankingResult<T> | null>,
		args: {
			providerKey: string;
			provider: string;
			strategy: CredentialRankingStrategy;
			rankingContext: CredentialRankingContext;
			blockScope?: string;
		},
		planRequirement: OpenAICodexPlanRequirement,
		nowMs: number,
	): UsageCandidate<T>[] {
		const { strategy } = args;
		const ranked: UsageRankedCandidate<T>[] = [];
		for (let orderPos = 0; orderPos < usageResults.length; orderPos += 1) {
			const result = usageResults[orderPos];
			if (!result) continue;
			const { selection, usage, usageChecked } = result;
			let { blockedUntil } = result;
			let blocked = blockedUntil !== undefined;
			const scopedLimits = usage ? getScopedUsageLimits(strategy, usage, args.rankingContext) : undefined;
			if (!blocked && scopedLimits && isUsageLimitReached(scopedLimits)) {
				const resetAtMs = getUsageResetAtMs(scopedLimits, nowMs);
				blockedUntil = resetAtMs ?? Date.now() + defaultBackoffMs;
				this.#blocks.markCredentialBlocked(
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
				planPriority: getOpenAICodexPlanPriority(usage, planRequirement),
				secondaryUsed: normalizeUsageFraction(secondaryTarget),
				secondaryRequiredDrain: computeWindowRequiredDrain(
					secondaryTarget,
					nowMs,
					strategy.windowDefaults.secondaryMs,
				),
				primaryUsed: normalizeUsageFraction(primary),
				primaryRequiredDrain: computeWindowRequiredDrain(primary, nowMs, strategy.windowDefaults.primaryMs),
				orderPos,
			});
		}
		return orderUsageRankedCandidates(ranked, planRequirement);
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
		// Pre-fetch usage reports in parallel for non-blocked credentials.
		// Wrap with a timeout so slow/429'd fetches don't indefinitely block
		// credential selection — better to pick a credential without usage data
		// than to hang the agent waiting for rate-limited usage endpoints.
		const usageTimeout = Math.max(5000, this.#usageRequestTimeoutMs * 1.5);
		const usagePromise = Promise.all(
			args.order.map(async idx => {
				const selection = args.credentials[idx];
				if (!selection) return null;
				let blockedUntil = this.#blocks.getCredentialBlockedUntil(
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
					blockedUntil = this.#blocks.getCredentialBlockedUntil(
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
		// `Bun.sleep` keeps the event loop alive even after Promise.race resolves,
		// which leaks a 7.5–15s timer per credential-selection call. Use an unref'd
		// timer so the timeout doesn't pin the process and clear it on the happy
		// path so memory drops immediately.
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

		return this.#rankUsageResults(usageResults, args, args.planRequirement, nowMs);
	}

	/**
	 * Resolves an OAuth credential, trying credentials in priority order.
	 *
	 * Resolution ladder — a request in hand always beats "no API key":
	 * 1. strict: unblocked credentials only, usage limits respected, plan
	 *    filter enforced (when any account is confirmed eligible);
	 * 2. plan-fitting last resort: same plan filter, but blocked/exhausted
	 *    accounts are allowed (blocked candidates rank earliest-unblocking
	 *    first) so the caller gets real usage-limit semantics from the wire
	 *    instead of a missing key;
	 * 3. unfiltered last resort: the plan filter matched nothing usable —
	 *    skip it and try every account once; the server is the final arbiter
	 *    of model access.
	 *
	 * Returns both the API key bytes for outbound requests AND the refreshed
	 * {@link OAuthCredential} so callers needing identity metadata (account id,
	 * project id, etc.) do not have to dereference the snapshot themselves.
	 */
	async #resolveOAuthSelection(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
	): Promise<OAuthResolutionResult | undefined> {
		const credentials = this.#getCredentialsForProvider(provider)
			.map((credential, index) => ({ credential, index }))
			.filter((entry): entry is { credential: OAuthCredential; index: number } => entry.credential.type === "oauth");

		if (credentials.length === 0) return undefined;

		const providerKey = getProviderTypeKey(provider, "oauth");
		const order = this.#getCredentialOrder(providerKey, sessionId, credentials.length);
		const strategy = this.#rankingStrategyResolver?.(provider);
		const rankingContext: CredentialRankingContext = { modelId: options?.modelId };
		const blockScope = strategy?.blockScope?.(rankingContext);
		const planRequirement = resolveOpenAICodexPlanRequirement(provider, options?.modelId);
		const hasPlanRequirement = planRequirement !== "none";
		const checkUsage = strategy !== undefined && (credentials.length > 1 || hasPlanRequirement);
		const sessionCredential = this.#routing.getSessionCredential(provider, sessionId);
		const sessionPreferredIndex = sessionCredential?.type === "oauth" ? sessionCredential.index : undefined;
		const sessionPreferredCredential =
			sessionPreferredIndex !== undefined
				? credentials.find(entry => entry.index === sessionPreferredIndex)?.credential
				: undefined;
		const sessionPreferredCanRefreshOrUse =
			sessionPreferredCredential !== undefined &&
			(sessionPreferredCredential.refresh.trim().length > 0 ||
				Date.now() + OAUTH_REFRESH_SKEW_MS < sessionPreferredCredential.expires);
		// Skip ranking only when the session already has a working preferred credential — re-ranking
		// mid-session causes account switches that cold-start the server-side prompt cache. New sessions
		// (no preference) and sessions whose preferred is blocked still rank, so we pick the account
		// with the most headroom proactively and fall back intelligently when rate-limited.
		const sessionPreferredIsAvailable =
			sessionPreferredIndex !== undefined &&
			sessionPreferredCanRefreshOrUse &&
			!this.#blocks.isCredentialBlocked(provider, providerKey, sessionPreferredIndex, blockScope);
		// The explicitly chosen account, which outranks every automatic decision below:
		// ranking may reorder around it, a hold may not displace it, and the strict pass may not skip
		// it. `sessionPreferredIndex` is not the same thing — it also carries sticky routing, which is
		// a record of what served last rather than anything anybody asked for.
		const chosenIndex = this.#explicitChoiceIndex(provider, sessionId, "oauth");
		const movementAllowed = this.#loadBalancingEnabled();
		// Ranking is a headroom contest among accounts, i.e. a move. With movement off it runs only
		// for a plan requirement, where the usage report is what says whether an account can serve
		// the model at all; a session that already has a working account never re-ranks either way.
		const shouldRank =
			checkUsage && (movementAllowed ? !sessionPreferredIsAvailable || hasPlanRequirement : hasPlanRequirement);
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
				// has a working preferred account) still has to answer "which
				// account first" while some of them are blocked. Round-robin order
				// alone puts a blocked account ahead of a usable one, and under a
				// provider-wide quota wall it puts the longest-blocked one first.
				this.#orderByBlockAvailability(
					provider,
					providerKey,
					order.map(idx => credentials[idx]),
					blockScope,
				).map(selection => ({ selection, usage: null, usageChecked: false }));

		// Enforce a tier only when at least one account is confirmed eligible. If
		// every report is unknown or ineligible, preserve trial/grandfathered access
		// by allowing the normal candidate fallback to attempt the request.
		const enforcePlanRequirement =
			hasPlanRequirement &&
			candidates.some(candidate => getOpenAICodexPlanEligibility(candidate.usage, planRequirement) === true);

		// The chosen account leads, hold or no hold. With movement off the session's last-used account
		// has the same standing, and so does the first account in storage order when the session has
		// none yet: that is the one account the provider is held to. With movement on the sticky
		// account leads only while usable, since a hold is then a reason to move.
		//
		// A plan requirement is the one thing that can still displace a lead: an account without
		// the entitlement cannot serve the model at all, so leading with it would fail the request
		// rather than honour anything. An eligible lead still leads.
		const leadIndex = movementAllowed
			? (chosenIndex ?? sessionPreferredIndex)
			: (this.#homeIndex(provider, sessionId, "oauth") ??
				// Storage order, not `candidates` order: a plan requirement ranks candidates by headroom,
				// and the first of THOSE would be a headroom winner, i.e. a move.
				credentials.find(entry => {
					const id = this.#getStoredCredentials(provider)[entry.index]?.id;
					return id === undefined || !this.#authDeadCredentials.has(id);
				})?.index);
		if (leadIndex !== undefined) {
			const leadCandidate = candidates.findIndex(
				candidate =>
					candidate.selection.index === leadIndex &&
					(candidate.selection.index === chosenIndex ||
						!movementAllowed ||
						!this.#blocks.isCredentialBlocked(provider, providerKey, candidate.selection.index, blockScope)) &&
					(!enforcePlanRequirement || getOpenAICodexPlanEligibility(candidate.usage, planRequirement) === true),
			);
			if (leadCandidate > 0) {
				const [lead] = candidates.splice(leadCandidate, 1);
				candidates.unshift(lead);
			}
		}
		// With movement off, the head of the list is the ONLY account this resolve may spend. A
		// sibling is reached in exactly two ways, neither of which is a move this setting governs:
		// the head's grant is refused (auth death, which disables the row and re-resolves without it,
		// announced through the failover notice) or the head cannot serve the model's plan tier.
		// Everything else — a hold, a transient refresh failure — is a reason to wait or to fail
		// this request, never to spend an account nobody offered up.
		const home = movementAllowed ? undefined : candidates[0];
		const homeIneligible =
			home !== undefined &&
			enforcePlanRequirement &&
			getOpenAICodexPlanEligibility(home.usage, planRequirement) !== true;
		if (home && !homeIneligible) candidates.splice(1);
		// Step (b) of the auth-retry policy: when `forceRefresh` is set, re-mint
		// the session-preferred credential (or the first candidate when no
		// session preference exists yet) even if its cached token still looks
		// valid — a peer/broker may have rotated it out from under us.
		const forceRefreshIndex = options?.forceRefresh
			? (sessionPreferredIndex ?? candidates[0]?.selection.index)
			: undefined;
		// A definitive dead-grant verdict from the preflight below, carried to the
		// attempt loop so the same dead token is not sent a second time. Keyed by
		// the candidate object because the two candidate shapes (ranked and plain)
		// have no common field to hang it on, and positional indices shift under a
		// concurrent disable.
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
					// Hand #refreshOAuthCredential a stale clone (expires:0) so its
					// not-yet-expired short-circuit doesn't suppress the forced
					// re-mint; an in-flight peer refresh is still awaited via the
					// per-credential single-flight.
					const refreshTarget = force
						? { ...candidate.selection.credential, expires: 0 }
						: candidate.selection.credential;
					const refreshedCredentials = await this.#refresher.refreshOAuthCredential(
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
					// Recovery for definitive failures (incl. peer rotation) lives in
					// #tryOAuthCredential; log instead of swallowing silently — a bare
					// catch here hid stale-refresh-token replays from concurrent
					// sessions (one-turn 401 "Invalid authentication credentials").
					logger.debug("OAuth preflight refresh failed", {
						provider,
						index: candidate.selection.index,
						error: String(error),
					});
					// A definitive rejection means the grant is dead, so the attempt
					// loop must not spend a round trip re-asking. Hand it the verdict;
					// a transient failure is deliberately NOT carried, because there
					// the retry IS the recovery.
					if (AIError.isDefinitiveOAuthFailure(String(error))) {
						preflightDefinitiveErrors.set(candidate, error);
					}
				}
			}),
		);

		// The strict pass tries a usable account before an exhausted one, which is what makes quota
		// fallback work. An explicitly chosen account is exempt from it: a hold is our own prediction,
		// and skipping the chosen account over a prediction is what left a redeemed limit reset
		// unable to spend the very account it belonged to. With movement off the home account is
		// exempt for the same reason — it is the one account allowed to serve, blocked or not. Every
		// other account still waits for the blocked-allowing pass, and a dead grant still falls through
		// to a sibling from either pass, because auth death is the provider's verdict rather than ours.
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
						allowBlocked: pass.allowBlocked || candidate.selection.index === chosenIndex || candidate === home,
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

	/** Attempts to use a single OAuth credential, checking usage and refreshing token. */
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
			/** When false, a definitive failure of THIS credential returns undefined instead of falling back to the ranked/round-robin selector (target-only resolution). */
			allowFallback?: boolean;
			/**
			 * A DEFINITIVE dead-grant rejection this same call already got from the
			 * preflight refresh of this credential. Reused instead of replaying the
			 * token, which could only earn a second identical rejection; the disable
			 * decision is owned here, so the verdict has to travel rather than the
			 * request being repeated.
			 */
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
		if (!allowBlocked && this.#blocks.isCredentialBlocked(provider, providerKey, selection.index, blockScope)) {
			return undefined;
		}

		if (!(await this.#prepareOAuthCredentialForRequest(provider, selection, options))) {
			return undefined;
		}
		// Capture the row id once, immediately after #prepareOAuthCredentialForRequest
		// resynced selection.index from the store. A concurrent disable during the
		// usage/refresh awaits below can shift positional indices, so every later
		// refresh / persist / CAS-disable addresses the row by this stable id.
		const credentialId = this.#getStoredCredentials(provider)[selection.index]?.id;

		const planRequirement = providedPlanRequirement ?? resolveOpenAICodexPlanRequirement(provider, options?.modelId);
		const hasPlanRequirement = planRequirement !== "none";
		const applyPlanFilter = enforcePlanRequirement ?? hasPlanRequirement;
		let usage: UsageReport | null = null;
		let usageChecked = false;
		// The usage report rules the credential out when the plan filter fails or its scoped limit is
		// reached, which also blocks the row. Asked once before the refresh and once after it, since a
		// rotation can land on another account.
		const usageRejects = (): boolean => {
			if (applyPlanFilter && getOpenAICodexPlanEligibility(usage, planRequirement) !== true) return true;
			if (checkUsage && !allowBlocked && usage && strategy && rankingContext) {
				const scopedLimits = getScopedUsageLimits(strategy, usage, rankingContext);
				if (isUsageLimitReached(scopedLimits)) {
					const resetAtMs = getUsageResetAtMs(scopedLimits, Date.now());
					this.#blocks.markCredentialBlocked(
						provider,
						providerKey,
						selection.index,
						resetAtMs ?? Date.now() + defaultBackoffMs,
						blockScope,
					);
					return true;
				}
			}
			return false;
		};

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
			if (usageRejects()) return undefined;
		}

		try {
			// The preflight already refreshed this credential in this same call and
			// the provider rejected the grant definitively. The token is single-use
			// and now dead, so asking again is a guaranteed second 400: reuse the
			// verdict and drop into the handling below, which is where disabling
			// (and the peer-rotation re-read that can still rescue the row) lives.
			if (preflightDefinitiveError !== undefined) throw preflightDefinitiveError;
			let result: { newCredentials: OAuthCredentials; apiKey: string } | null;
			const customProvider = getOAuthProvider(provider);
			if (customProvider) {
				const refreshedCredentials = await this.#refresher.refreshOAuthCredential(
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
				// Refresh first through the broker-aware single-flighted machinery
				// so transient failures surface as network errors (5-min temp block)
				// instead of `getOAuthApiKey`'s "expired" precondition error, which
				// the definitive-failure regex below would otherwise classify as
				// auth failure and soft-disable a still-valid credential.
				const refreshedCredentials = await this.#refresher.refreshOAuthCredential(
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
				if (usageRejects()) return undefined;
			}
			this.#recordOAuthBearerCredentialId(provider, result.apiKey, credentialId);
			this.#recordSessionCredential(provider, sessionId, "oauth", selection.index);
			return { apiKey: result.apiKey, credential: updated, credentialId };
		} catch (error) {
			const errorMsg = String(error);
			// Only remove credentials for definitive auth failures
			// Keep credentials for transient errors (network, 5xx) and block temporarily
			const isDefinitiveFailure = AIError.isDefinitiveOAuthFailure(errorMsg);

			logger.warn("OAuth token refresh failed", {
				provider,
				index: selection.index,
				error: errorMsg,
				isDefinitiveFailure,
			});

			if (isDefinitiveFailure) {
				// The credential at this index may have been rotated by another process between
				// our in-memory snapshot and the refresh attempt: Anthropic rotates refresh
				// tokens on every use, so the peer's success leaves our stored token invalid.
				// Re-read the row from disk before marking it disabled — if the persisted
				// refresh token has changed, the peer rotation succeeded and we should pick
				// up the new credential instead of soft-deleting the row that the peer just
				// updated.
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
				// The row is about to be disabled and the request will re-resolve onto a sibling. That is
				// a move, and it must be announced like the one `rotateSessionCredential` makes: park the
				// dying account's label NOW, while the row can still be named, and let the resolve that
				// serves emit the notice. Without this the move made here — the same auth death, found
				// by the resolver instead of by a rejected request — was the one silent move left.
				const siblingRemains = this.#getStoredCredentials(provider).some(
					row => row.credential.type === "oauth" && row.id !== credentialId,
				);
				if (credentialId !== undefined && siblingRemains && allowFallback) {
					this.#pendingFailover.set(provider, {
						from: { credentialId, label: this.#accountNoticeLabel(provider, credentialId) },
						cause: authFailureCause(error),
						at: Date.now(),
					});
				}
				// Permanently disable invalid credentials with an explicit cause for inspection/debugging.
				// Use a CAS-style disable conditioned on the row still containing the stale credential
				// we tried to refresh, so a peer rotation that lands between the pre-check above and
				// this disable doesn't soft-delete the freshly-rotated row.
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
				// Block temporarily for transient failures (5 minutes)
				this.#blocks.markCredentialBlocked(provider, providerKey, selection.index, Date.now() + 5 * 60 * 1000);
			}
		}

		return undefined;
	}

	/**
	 * Peek at API key for a provider without refreshing OAuth tokens.
	 * Used for model discovery where we only need to know if credentials exist
	 * and get a best-effort token. For GitHub Copilot we preserve enterprise
	 * routing metadata so discovery can hit the correct host.
	 */
	async peekApiKey(provider: string): Promise<string | undefined> {
		const runtimeKey = this.#runtimeOverrides.get(provider);
		if (runtimeKey) {
			return runtimeKey;
		}

		const configKey = this.#configOverrides.get(provider);
		if (configKey) {
			return configKey;
		}

		// Precedence: a deliberate OAuth/login credential wins, then an explicit env var,
		// then a stored static api_key (which may be a stale broker-migrated copy) as a last resort.
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

	/**
	 * Get API key for a provider.
	 * Priority (first match wins):
	 * 1. Runtime override (CLI --api-key)
	 * 2. Config override (models.yml `providers.<name>.apiKey`)
	 * 3. OAuth token from storage (auto-refreshed)
	 * 4. API key persisted by a successful `/login`
	 * 5. Environment variable
	 * 6. Stored API key (e.g. a broker-migrated copy) — last resort, so an explicit env var wins
	 * 7. Fallback resolver (models.yml custom providers, last-resort)
	 */
	async getApiKey(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<string | undefined> {
		// Runtime override takes highest priority
		const runtimeKey = this.#runtimeOverrides.get(provider);
		if (runtimeKey) {
			return runtimeKey;
		}

		// Config override: explicit apiKey pinned in models.yml beats the broker's
		// OAuth credentials. The user redirected a provider at a custom baseUrl
		// (e.g. an auth-gateway) and supplied the bearer for that endpoint —
		// honor it instead of forwarding an upstream OAuth token that the proxy
		// won't accept.
		const configKey = this.#configOverrides.get(provider);
		if (configKey) {
			return configKey;
		}

		// Precedence: a deliberate OAuth/login credential wins, then an explicit env var,
		// then a stored static api_key (which may be a stale broker-migrated copy) as a last resort.
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

		// Past OAuth: the session sticky (if any) is stale — the request authenticates via
		// env/api_key/fallback, not OAuth, so clear it now so getOAuthAccountId() correctly
		// suppresses account_uuid for this session.
		if (sessionId) this.#routing.forgetStickySessionCredential(provider, sessionId);

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

		// Fall back to custom resolver (e.g., models.json custom providers)
		return this.#fallbackResolver?.(provider) ?? undefined;
	}

	/**
	 * Resolve the OAuth credential for `provider`, refreshing through the same
	 * pipeline as {@link AuthStorage.getApiKey} but returning the refreshed
	 * {@link OAuthAccess} (raw access token + identity metadata) instead of
	 * the API-key bytes.
	 *
	 * Use this when the caller needs to inject identity headers alongside the
	 * bearer (Codex `chatgpt-account-id`, Google `project`, GitHub
	 * `enterpriseUrl`). For pure "give me the bytes for `Authorization`"
	 * scenarios, prefer {@link AuthStorage.getApiKey}.
	 *
	 * Returns `undefined` when no OAuth credential is available, the
	 * credential fails to refresh, or runtime/config overrides have replaced
	 * OAuth with an explicit API key.
	 */
	async getOAuthAccess(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
	): Promise<OAuthAccess | undefined> {
		// Runtime / config overrides intentionally short-circuit OAuth: when the
		// user has pinned an API key, they expect the OAuth identity to be
		// suppressed (same contract as `getOAuthAccountId`).
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

	/** Stored OAuth credentials for `provider` in stable order, paired with their full-list index and row id. */
	#getStoredOAuthSelections(provider: string): StoredOAuthSelection[] {
		return this.#getStoredCredentials(provider)
			.map((entry, index) => ({ credentialId: entry.id, credential: entry.credential, index }))
			.filter((entry): entry is StoredOAuthSelection => entry.credential.type === "oauth");
	}

	/** Refresh one stored OAuth selection and shape it as an {@link OAuthAccessResolution}. */
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

	/**
	 * Read-only list of stored OAuth accounts for `provider` in stable storage
	 * order, WITHOUT refreshing any token. The array position (0-based) is the
	 * selector accepted by {@link AuthStorage.getOAuthAccessAt}; a "pick the Nth
	 * account" UI should render `position + 1`.
	 */
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

	/**
	 * Resolve every stored OAuth credential for `provider` independently.
	 *
	 * Refreshes credentials through the same broker/local path as
	 * {@link AuthStorage.getOAuthAccess}, but does not rank, round-robin, or
	 * stop after the first usable account. Intended for diagnostics that must
	 * exercise each stored account exactly once.
	 */
	async getOAuthAccesses(provider: string, options?: AuthApiKeyOptions): Promise<OAuthAccessResolution[]> {
		if (this.#runtimeOverrides.has(provider) || this.#configOverrides.has(provider)) {
			return [];
		}
		const providerKey = getProviderTypeKey(provider, "oauth");
		return Promise.all(
			this.#getStoredOAuthSelections(provider).map(selection =>
				this.#resolveStoredOAuthAccess(provider, selection, providerKey, options),
			),
		);
	}

	/**
	 * Resolve a single stored OAuth credential by its account position (0-based,
	 * matching {@link AuthStorage.listOAuthAccounts}). Refreshes ONLY that
	 * credential ({@link #resolveStoredOAuthAccess} runs with `allowFallback:
	 * false`), so — unlike {@link AuthStorage.getOAuthAccesses} — a definitive
	 * failure of the targeted account surfaces as a failed resolution rather than
	 * silently rotating or rate-tripping a sibling.
	 *
	 * Returns `undefined` when `position` is out of range or runtime/config
	 * overrides have replaced OAuth with an explicit API key.
	 */
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
		const providerKey = getProviderTypeKey(provider, "oauth");
		return this.#resolveStoredOAuthAccess(provider, selection, providerKey, options);
	}

	/**
	 * List saved rate-limit resets for every stored OAuth account of each
	 * reset-capable provider (or only `provider`), fetched LIVE from the
	 * provider's reset route: Codex `wham/rate-limit-reset-credits`, Anthropic
	 * `api/oauth/usage?cedar_ember=1`.
	 *
	 * This deliberately bypasses the usage-report cache: both usage endpoints
	 * are IP-rate-limited and may serve stale (or pre-feature) snapshots when
	 * many accounts are polled, which would hide redeemable credits. One entry
	 * per account, with the session's active account of each provider flagged
	 * and unreachable accounts carrying an `error`.
	 */
	async listResetCredits(options?: {
		provider?: ResetCreditProvider;
		sessionId?: string;
		baseUrlResolver?: (provider: string) => string | undefined;
		signal?: AbortSignal;
	}): Promise<ResetCreditAccountStatus[]> {
		const providers = options?.provider ? [options.provider] : RESET_CREDIT_PROVIDERS;
		const perProvider = await Promise.all(
			providers.map(provider => this.#listProviderResetCredits(provider, options)),
		);
		return perProvider.flat();
	}

	async #listProviderResetCredits(
		provider: ResetCreditProvider,
		options:
			| { sessionId?: string; baseUrlResolver?: (provider: string) => string | undefined; signal?: AbortSignal }
			| undefined,
	): Promise<ResetCreditAccountStatus[]> {
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
					provider,
					credentialId: access.credentialId,
					accountId: access.accountId,
					email: access.email,
					active,
				};
				if (!access.ok) return { ...base, availableCount: 0, credits: [], error: access.error };
				const auth = { accessToken: access.accessToken, baseUrl, fetch: this.#usageFetch, signal: options?.signal };
				if (provider === "anthropic") {
					const read = await fetchAnthropicResetStatus(auth);
					if (!read) return { ...base, availableCount: 0, credits: [], error: "Failed to load usage resets" };
					const now = Date.now();
					return {
						...base,
						availableCount: anthropicResetAvailableCount(read.status, now),
						credits: anthropicResetCredits(read.status, now).credits ?? [],
					};
				}
				const list = await listCodexResetCredits({ ...auth, accountId: access.accountId });
				if (!list) return { ...base, availableCount: 0, credits: [], error: "Failed to load saved resets" };
				return {
					...base,
					availableCount: list.availableCount,
					credits: list.credits.map(credit => ({
						id: credit.id,
						title: credit.title,
						grantedAt: credit.grantedAt,
						expiresAt: credit.expiresAt,
						status: credit.status,
					})),
				};
			}),
		);
	}

	/**
	 * Redeem one saved rate-limit reset for a specific stored account of
	 * `target.provider` (OpenAI Codex saved resets, Anthropic usage-limit resets).
	 *
	 * Resolves a fresh access token for the target account, picks a credit (the
	 * given `creditId`, else the provider's next redeemable one), spends it, and
	 * invalidates the cached usage report so the next `/usage` reflects the
	 * reset. Never throws for business outcomes — inspect the returned `code`.
	 */
	async redeemResetCredit(options: {
		target: ResetCreditTarget;
		creditId?: string;
		baseUrlResolver?: (provider: string) => string | undefined;
		signal?: AbortSignal;
	}): Promise<ResetCreditRedeemOutcome> {
		const { target } = options;
		const provider = target.provider;
		const baseUrl = options.baseUrlResolver?.(provider);
		const accesses = await this.getOAuthAccesses(provider);
		const match = accesses.find(
			access =>
				(target.credentialId !== undefined && access.credentialId === target.credentialId) ||
				(!!target.accountId && access.accountId === target.accountId) ||
				(!!target.email && access.email === target.email),
		);
		if (!match) {
			return { ok: false, code: "no_account", provider, accountId: target.accountId, email: target.email };
		}
		const who = { provider, accountId: match.accountId, email: match.email };
		if (!match.ok) return { ok: false, code: "account_unavailable", ...who };

		const auth = { accessToken: match.accessToken, baseUrl, fetch: this.#usageFetch, signal: options.signal };
		const spent =
			provider === "anthropic"
				? await spendAnthropicReset(match, auth, options.creditId)
				: await spendCodexReset(match, auth, options.creditId);
		if (spent.code === "reset") {
			this.#invalidateUsageReportCache(provider, baseUrl);
			if (this.#store.invalidateUsageCache) {
				await this.#store.invalidateUsageCache(options.signal).catch(err => {
					logger.debug("Failed to notify store of stale usage", { err });
				});
			}
			// The window this credential was blocked on (by markUsageLimitReached)
			// is now reset, so lift its temporary block — otherwise selection
			// keeps skipping/under-ranking the freshly-reset account.
			if (match.credentialId !== undefined) this.clearCredentialBlocks(provider, match.credentialId);
		}
		return { ok: spent.code === "reset", code: spent.code, creditId: spent.creditId, ...who };
	}

	/**
	 * Force the next usage fetch for `provider` to bypass the 5-min cache, so
	 * `/usage` reflects a freshly-redeemed reset instead of stale numbers.
	 */
	#invalidateUsageReportCache(provider: string, baseUrl?: string): void {
		this.#usageCacheEpoch += 1;
		const expired = Date.now() - 1;
		for (const entry of this.#getStoredCredentials(provider)) {
			if (entry.credential.type !== "oauth") continue;
			const cacheKey = buildUsageReportCacheKey(buildUsageRequestForOauth(provider, entry.credential, baseUrl));
			const existing = this.#usageCache.getStale<UsageReport | null>(cacheKey);
			this.#usageCache.set(cacheKey, { value: existing?.value ?? null, expiresAt: expired });
		}
	}

	/**
	 * Force-invalidate cached usage reports so the next fetch retrieves fresh
	 * values from upstream providers. If `provider` is specified, only that
	 * provider's credentials are invalidated; otherwise, all credentials in the
	 * store are invalidated.
	 */
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
					const cacheKey = buildUsageReportCacheKey(buildUsageRequestForOauth(entry.provider, entry.credential));
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

	/**
	 * Lift every temporary rate-limit block on one credential: the persisted rows, and the
	 * in-memory backoff under the bare `provider:<type>` key and its scoped `\0` derivatives.
	 *
	 * Public because a block is OUR prediction, not a fact the provider is holding us to, and it
	 * outlives the thing that justified it. Two ways that happens: a saved reset is redeemed (the
	 * window the block described no longer exists), and the provider lifts a limit by some route
	 * this process never sees — a reset redeemed on the provider's own site, a plan
	 * change, a support credit. Nothing but time cleared a block in the second case, so an account
	 * the provider would serve today sat unusable behind a countdown for as long as the stale
	 * deadline ran, and an explicit choice of account lost to it.
	 *
	 * The block is keyed by the credential's OWN type. It read `oauth` unconditionally, so a
	 * blocked API-key row could not be lifted by anything, including the redeem path.
	 */
	clearCredentialBlocks(provider: string, credentialId: number): void {
		try {
			this.deleteCredentialBlocks(credentialId);
		} catch (err) {
			logger.debug("Failed to clear persisted credential blocks", { err, provider, credentialId });
		}
		// A lifted hold is a statement that this account should be tried again, so it
		// also retires the auth-death mark: the provider, not a mark this process made, gets to say
		// whether the grant still works.
		this.#authDeadCredentials.delete(credentialId);

		const stored = this.#getStoredCredentials(provider);
		const index = stored.findIndex(entry => entry.id === credentialId);
		if (index < 0) return;
		this.#blocks.clearCredentialBlocks(getProviderTypeKey(provider, stored[index]!.credential.type), index);
	}

	#reconcileCodexUsageBlockForCredential(provider: Provider, credentialId: number, report: UsageReport): void {
		if (!isHealthyCodexUsageReport(report)) return;
		const providerKey = getProviderTypeKey(provider, "oauth");
		const credentialIndex = this.#getStoredCredentials(provider).findIndex(entry => entry.id === credentialId);
		if (credentialIndex < 0) return;
		// Mirror selection: consult the same strategy scope `markUsageLimitReached`
		// persists under, else a scoped block is invisible here and never healed.
		const blockScope = this.#rankingStrategyResolver?.(provider)?.blockScope?.({});
		const blockedUntilMs = this.#blocks.getCredentialBlockedUntil(provider, providerKey, credentialIndex, blockScope);
		if (blockedUntilMs === undefined) return;
		// `/usage` can lag the request path that just returned 429. Fresh local or
		// broker-sourced blocks get one usage-cache window before healthy reports may
		// clear them.
		const nowMs = Date.now();
		const localReconcileAfterMs = this.#blocks.reconcileAfterMs(providerKey, blockScope, credentialIndex);
		const getStoreReconcileAfter = this.#store.getCredentialBlockReconcileAfter?.bind(this.#store);
		const storeGlobalProbeAfterMs = getStoreReconcileAfter?.(credentialId, providerKey, "") ?? 0;
		const storeScopedProbeAfterMs = getStoreReconcileAfter?.(credentialId, providerKey, blockScope ?? "") ?? 0;
		if (Math.max(localReconcileAfterMs, storeGlobalProbeAfterMs, storeScopedProbeAfterMs) > nowMs) {
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
		const email = getUsageReportMetadataValue(report, "email")?.toLowerCase();
		const accountId = (
			getUsageReportMetadataValue(report, "accountId") ?? getUsageReportScopeAccountId(report)
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
			if (!isHealthyCodexUsageReport(report)) continue;
			for (const credentialId of this.#findStoredCredentialIdsForUsageReport(report)) {
				if (reconciled.has(credentialId)) continue;
				reconciled.add(credentialId);
				this.#reconcileCodexUsageBlockForCredential(report.provider, credentialId, report);
			}
		}
	}

	async #credentialMatchesApiKey(credential: AuthCredential, apiKey: string): Promise<boolean> {
		if (credential.type === "api_key") {
			return (await this.#configValueResolver(credential.key)) === apiKey;
		}
		if (credential.access === apiKey) return true;
		return extractStructuredApiKeyToken(apiKey) === credential.access;
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

		this.#routing.clearSessionCredential(provider, sessionId);
		// This is the auth-death path (the gateway's usage-limit case never reaches here), so the
		// grant is refused for the same purposes `rotateSessionCredential` refuses one: an explicit
		// choice stops pinning traffic to it, ordering with movement off sorts it last, and the move
		// the next resolve makes is announced rather than silent.
		this.#authDeadCredentials.add(matched.id);
		this.#blocks.markCredentialBlocked(
			provider,
			getProviderTypeKey(provider, matched.type),
			matched.index,
			Date.now() + defaultBackoffMs,
		);
		const failed = matched;
		const siblingRemains = stored.some(
			(entry, index) => index !== failed.index && entry.credential.type === failed.type,
		);
		if (siblingRemains) {
			this.#pendingFailover.set(provider, {
				from: { credentialId: matched.id, label: this.#accountNoticeLabel(provider, matched.id) },
				cause: "credential rejected",
				at: Date.now(),
			});
		}

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

	/**
	 * Rotate away from the credential that failed after a retryable auth error —
	 * step (c) of the auth-retry policy. Prefer the failed stored row id supplied
	 * in `options.credentialId`, then the failed bearer supplied in
	 * `options.apiKey`, so overlapping requests cannot redirect rotation through
	 * stale session stickiness. Fall back to the session-sticky credential only
	 * when neither explicit target is available. For hard-auth errors, an explicit
	 * target that no longer matches storage returns `false` without mutation.
	 * Delayed usage-limit errors may instead recover the durable OAuth row from
	 * the bearer fingerprint recorded when the request resolved.
	 *
	 * - usage-limit / account-rate-limit error → {@link AuthStorage.markUsageLimitReached}
	 *   (temporary block via its own backoff — default plus server usage-report
	 *   reset; sticky left intact so the next resolve re-ranks around the block).
	 * - otherwise (hard 401 / auth failure) → mark the credential suspect (or
	 *   reload when no broker hook is wired) and block it, then drop matching
	 *   sticky state.
	 *
	 * Returns whether another usable credential of the same type remains.
	 */
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

		const providerKey = getProviderTypeKey(provider, sessionCredential.type);
		// Snapshot sibling availability before mutating so a soft-deleting
		// suspect hook can't reindex the answer out from under us.
		const hasSibling = this.#getCredentialsForProvider(provider).some(
			(credential, index) =>
				credential.type === sessionCredential.type &&
				index !== sessionCredential.index &&
				!this.#blocks.isCredentialBlocked(provider, providerKey, index),
		);
		const target = this.#getStoredCredentials(provider)[sessionCredential.index];
		const sticky = this.#routing.getSessionCredential(provider, sessionId);
		if (
			!sessionCredential.explicit ||
			(sticky?.type === sessionCredential.type && sticky.index === sessionCredential.index)
		) {
			this.#routing.clearSessionCredential(provider, sessionId);
		}
		// Everything from here down is the NON-quota path: the usage-limit case returned above. So the
		// account failed authentication, and an explicit choice must stop pinning traffic to it —
		// otherwise a revoked grant would be retried until the turn died instead of failing over.
		if (target) this.#authDeadCredentials.add(target.id);
		this.#blocks.markCredentialBlocked(provider, providerKey, sessionCredential.index, Date.now() + defaultBackoffMs);

		if (hasSibling && target) {
			// Parked, not emitted: the label of the account that DIED must be read now, before
			// `markCredentialSuspect` soft-deletes the row and the name it was known by with it.
			// The replacement is named later, by the resolve that actually serves.
			this.#pendingFailover.set(provider, {
				from: { credentialId: target.id, label: this.#accountNoticeLabel(provider, target.id) },
				// The cause the operator reads, from the error itself: the notice is written after the
				// row is soft-deleted, so nothing else can answer what killed this credential.
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

	/**
	 * Build an {@link ApiKeyResolver} backed by this storage, implementing the
	 * central a/b/c auth-retry policy:
	 *
	 * - initial (`error: undefined`) → resolve the session credential.
	 * - step (b) `!lastChance` → force-refresh the SAME session-sticky credential.
	 * - step (c) `lastChance` → rotate to a sibling and re-resolve, unless quota exhaustion has no sibling.
	 *
	 * Used by web-search providers and other consumers that hold an AuthStorage
	 * directly (no ModelRegistry in scope).
	 */
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
					// Preserve no-sibling quota backoff instead of re-resolving an
					// already-blocked fallback. Hard-auth declines still re-resolve
					// because a peer may have refreshed the failed bearer.
					if (AIError.isUsageLimit(error)) return undefined;
				}
				return this.getApiKey(provider, sessionId, { baseUrl, modelId, signal });
			}
			return this.getApiKey(provider, sessionId, { baseUrl, modelId, forceRefresh: true, signal });
		};
	}

	// ─── Auth Broker integration ────────────────────────────────────────────

	/**
	 * Build a redacted snapshot of all loaded credentials for the auth-broker
	 * wire. OAuth refresh tokens are replaced with {@link REMOTE_REFRESH_SENTINEL}
	 * so clients never see the actual refresh token.
	 *
	 * Callers must {@link AuthStorage.reload} first when serving a stale snapshot
	 * (the broker server's HTTP handler does this).
	 */
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
		return { generation: this.#events.generation, generatedAt: Date.now(), credentials: entries };
	}

	/**
	 * Whether a loaded credential row carries this id. Same row set as
	 * {@link AuthStorage.exportSnapshot}, without building the redacted entries.
	 */
	hasCredentialId(id: number): boolean {
		for (const entries of this.#data.values()) {
			if (entries.some(entry => entry.id === id)) return true;
		}
		return false;
	}

	/**
	 * Refresh the OAuth credential with the given id through a per-credential
	 * single-flight. Concurrent callers for the same row await the same upstream
	 * refresh attempt, which is required for providers that rotate refresh tokens
	 * on every successful refresh.
	 */
	async refreshCredentialById(id: number, signal?: AbortSignal): Promise<AuthCredentialSnapshotEntry> {
		const existing = this.#oauthRefreshInFlight.get(id);
		if (existing) return raceWithSignal(existing, signal, "credential refresh aborted");

		const promise = (async () => {
			this.#events.bumpGeneration("credential-refresh-start");
			try {
				return await this.#forceRefreshCredentialByIdUnshared(id, signal);
			} catch (error) {
				this.#events.bumpGeneration("credential-refresh-failure");
				throw error;
			} finally {
				this.#oauthRefreshInFlight.delete(id);
			}
		})();
		this.#oauthRefreshInFlight.set(id, promise);
		return raceWithSignal(promise, signal, "credential refresh aborted");
	}

	/**
	 * Force-refresh the OAuth credential with the given id, bypassing the
	 * not-yet-expired guard. Used by the auth-broker server to honour
	 * `POST /v1/credential/:id/refresh`.
	 *
	 * Returns the redacted snapshot entry for the refreshed row.
	 * Throws when no OAuth credential with that id is loaded.
	 */
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
			// The exact credential we are about to refresh — captured before the
			// await so a definitive failure can CAS-disable the row against the
			// value we actually attempted (NOT the expires:0 clone below).
			const attempted = target.credential;
			// Pass a clone with expires=0 so the cached not-yet-expired short-circuit
			// in #refreshOAuthCredential doesn't suppress the requested refresh.
			const stale: OAuthCredential = { ...attempted, expires: 0 };
			let refreshed: OAuthCredentials;
			try {
				refreshed = await this.#refresher.refreshOAuthCredential(provider as Provider, stale, id, signal);
			} catch (error) {
				// A definitively-dead grant tears the row down here, where the
				// attempted credential is known. CAS on the persisted credential so a
				// peer/login rotation in flight leaves the freshly-rotated row intact.
				if (AIError.isDefinitiveOAuthFailure(String(error))) {
					// CAS-loss (false) means a peer/login rotated the row mid-refresh, so
					// our #data copy is stale — reload so the next caller serves the
					// freshly-rotated credential rather than the dead token we attempted.
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
			// Persist by id: the array may have been reordered/shrunk while the
			// refresh was in flight, so the pre-await positional index is unsafe. A
			// -1 means the row was disabled/removed mid-refresh — surface that as a
			// miss rather than implying a live row the snapshot won't contain.
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

	/**
	 * Disable the credential with the given id and emit a
	 * {@link CredentialDisabledEvent}. Used by the auth-broker server to honour
	 * `POST /v1/credential/:id/disable`. Returns `false` when no such row exists.
	 */
	disableCredentialById(id: number, disabledCause: string): boolean {
		for (const [provider, entries] of this.#data) {
			const index = entries.findIndex(entry => entry.id === id);
			if (index === -1) continue;
			this.#store.deleteAuthCredential(id, disabledCause);
			const next = entries.filter((_value, idx) => idx !== index);
			this.#setStoredCredentials(provider, next);
			this.#resetProviderAssignments(provider);
			this.#events.emitCredentialDisabled({ provider, disabledCause });
			return true;
		}
		return false;
	}

	/**
	 * Upsert a credential into the underlying store, refresh the in-memory
	 * snapshot, and return the redacted snapshot entries for the provider.
	 *
	 * Used by the auth-broker server to honour `POST /v1/credential`. The
	 * persistence layer (`SqliteAuthCredentialStore.upsertAuthCredentialForProvider`)
	 * does identity-key matching, so re-uploading the same email/account replaces
	 * the existing row instead of inserting a duplicate.
	 */
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

	/**
	 * Broker-server seam: list non-expired persisted blocks for snapshot entries.
	 */
	listCredentialBlocks(credentialIds: readonly number[]): StoredCredentialBlock[] {
		return this.#store.listCredentialBlocks?.(credentialIds) ?? [];
	}

	/**
	 * Broker-server seam: persist one credential block and notify snapshot waiters.
	 */
	upsertCredentialBlock(block: StoredCredentialBlock): void {
		const upsertCredentialBlock = this.#store.upsertCredentialBlock?.bind(this.#store);
		if (!upsertCredentialBlock) return;
		upsertCredentialBlock(block);
		this.#invalidateUsageReportCacheForProviderKey(block.providerKey);
		this.#events.bumpGeneration("credential-block");
	}

	/**
	 * Broker-server seam: clear all persisted blocks for one credential and notify snapshot waiters.
	 */
	deleteCredentialBlocks(credentialId: number): void {
		const deleteCredentialBlocks = this.#store.deleteCredentialBlocks?.bind(this.#store);
		if (!deleteCredentialBlocks) return;
		deleteCredentialBlocks(credentialId);
		this.#events.bumpGeneration("credential-block");
	}

	/**
	 * Describe where the active credential for a provider came from.
	 *
	 * Mirrors {@link AuthStorage.getApiKey} precedence, highest first:
	 *   1. Runtime override (`--api-key`).
	 *   2. Config override (`models.yml` `providers.<name>.apiKey`).
	 *   3. Stored OAuth credential.
	 *   4. API key persisted by a successful `/login`.
	 *   5. Env var — overrides a stored static api_key (e.g. a stale broker copy).
	 *   6. Stored api_key credential.
	 *   7. Fallback resolver.
	 *
	 * The string is purely informational; consumers must not parse it.
	 */
	describeCredentialSource(provider: string, sessionId?: string): string | undefined {
		if (this.#runtimeOverrides.has(provider)) {
			return "runtime override (--api-key)";
		}
		if (this.#configOverrides.has(provider)) {
			return "config override (models.yml)";
		}

		const baseLabel = this.#sourceLabel ?? "local store";
		const stored = this.#getStoredCredentials(provider);
		const session = sessionId ? this.#routing.peekStickySessionCredential(provider, sessionId) : undefined;
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

		// Deliberate login credentials win; then an explicit env var; then a stored static api_key.
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

// ─────────────────────────────────────────────────────────────────────────────
// SqliteAuthCredentialStore
// ─────────────────────────────────────────────────────────────────────────────

/** Row shape for auth_credentials table queries */

/**
 * The row helpers this module used to define, kept exported from here so no caller changed.
 *
 * `isSqliteBusyError` and `isRefreshFailureDisableCause` were public API of this module and are
 * imported by name across both packages; `auth-credential-rows.ts` is their one owner now.
 */
export {
	isRefreshFailureDisableCause,
	isSqliteBusyError,
	OAUTH_REFRESH_FAILURE_DISABLE_PREFIX,
} from "./auth-credential-rows";

/**
 * The sqlite store, which moved to `auth-storage-sqlite.ts` and is re-exported here.
 *
 * Every existing importer names this module or the package barrel, so the re-export is what makes the
 * move invisible to them. A caller that wants ONLY the store, and not the OAuth machinery in this file,
 * should import `@veyyon/ai/auth-storage-sqlite` directly: that is 213 modules cheaper.
 */
export { SqliteAuthCredentialStore };
