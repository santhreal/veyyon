/**
 * Credential management for API keys and OAuth tokens.
 *
 * This module defines:
 * - `AuthCredentialStore` interface: the persistence abstraction (SQLite, remote vault, ...)
 * - `AuthStorage` class: credential selection with round-robin, usage limits, OAuth refresh
 * - the credential types every consumer speaks: `AuthCredential`, `StoredAuthCredential`, and friends
 *
 * IT NO LONGER TOUCHES A DATABASE. The sqlite implementation moved to `auth-storage-sqlite.ts` and the
 * row logic to `auth-credential-rows.ts`, so this file has no `bun:sqlite` import, no filesystem import,
 * and no schema statements left: it decides WHICH credential to use and how to refresh it, and asks a
 * store to read or write rows. Both moved modules are re-exported at the bottom, so no caller changed.
 *
 * The reason for the split was cost, and the shape it revealed is the better argument. Reaching the
 * sqlite store meant importing this module, which imports the provider registry and its 75 provider
 * definitions, the OAuth flows, and the error taxonomy: 213 modules to write a credential row. The store
 * needed none of it, which is what "these are two jobs" looks like from the graph.
 */

import { createHash } from "node:crypto";
import * as logger from "@veyyon/utils/logger";
import { clamp, clamp01 } from "@veyyon/utils/math";
import { scopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";
import { errorMessage } from "@veyyon/utils/type-guards";
import { trimTrailingSlashes } from "@veyyon/utils/url";
// The env-key leaf, NOT `./stream`. This file wanted two table lookups and was pulling the whole
// streaming engine for them, which is most of why importing auth storage reached 276 modules.
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
// The store class itself, for the `AuthStorage.create` convenience factory. The edge runs ONE way:
// this module names the store, and the store names this module only for TYPES, which are erased. So
// importing the store alone does not pull the OAuth machinery below, which is the whole point.
import { SqliteAuthCredentialStore } from "./auth-storage-sqlite";
import { isRecordFromFutureClock } from "./credential-clock";
import { getEnvApiKey, getEnvApiKeyName } from "./env-api-key";
import * as AIError from "./error";
import { isUsageLimitOutcome } from "./error/rate-limit";
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
	UsageCostHistoryQuery,
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
	type CodexResetConsumeCode,
	type CodexResetCredit,
	consumeCodexResetCredit,
	listCodexResetCredits,
} from "./usage/openai-codex-reset";
import {
	listRegisteredUsageProviders,
	resolveRegisteredRankingStrategy,
	resolveRegisteredUsageProvider,
} from "./usage/registry";

/**
 * Process-wide cap for background authentication HTTP work. Broker refresh
 * sweeps and usage probes share this policy so overlapping callers cannot
 * multiply their individual fan-out into an unbounded aggregate burst.
 */
export const AUTH_HTTP_CONCURRENCY_LIMIT = 8;

type PendingAuthHttpOperation = () => void;

class AuthHttpConcurrencyPolicy {
	#active = 0;
	#queue: PendingAuthHttpOperation[] = [];
	#queueHead = 0;

	run<T>(operation: () => Promise<T>): Promise<T> {
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const start = () => {
			this.#active += 1;
			let pending: Promise<T>;
			try {
				pending = operation();
			} catch (error) {
				this.#release();
				reject(error);
				return;
			}
			void pending.then(
				value => {
					this.#release();
					resolve(value);
				},
				error => {
					this.#release();
					reject(error);
				},
			);
		};

		if (this.#active < AUTH_HTTP_CONCURRENCY_LIMIT) {
			start();
		} else {
			this.#queue.push(start);
		}
		return promise;
	}

	#release(): void {
		this.#active -= 1;
		const next = this.#queue[this.#queueHead];
		if (!next) return;
		this.#queueHead += 1;
		if (this.#queueHead === this.#queue.length) {
			this.#queue = [];
			this.#queueHead = 0;
		}
		next();
	}
}

const authHttpConcurrencyPolicy = new AuthHttpConcurrencyPolicy();

/** Runs one refresh or usage request under the shared authentication HTTP cap. */
export function withAuthHttpConcurrency<T>(operation: () => Promise<T>): Promise<T> {
	return authHttpConcurrencyPolicy.run(operation);
}

const USAGE_RANKING_METRIC_EPSILON = 1e-9;
/**
 * Primary (short, e.g. 5h) window used-fraction at or above which a candidate
 * is demoted behind cooler siblings during ranking: a nearly exhausted short
 * window means an imminent mid-session block, so drain urgency defers to it.
 */
const PRIMARY_WINDOW_HOT_FRACTION = 0.85;
const OAUTH_BEARER_FINGERPRINT_HISTORY_LIMIT = 8;

/** SHA-256 bearer fingerprint, so superseded OAuth token bytes never enter the identity cache. */
function fingerprintOAuthBearer(bearer: string): string {
	return createHash("sha256").update(bearer).digest("base64url");
}
const SESSION_STICKY_CACHE_PREFIX = "session:sticky:";
/**
 * Where a user's explicit account choice lives, kept apart from the sticky record above.
 *
 * The sticky record is ROUTING's own state: it is rewritten on every resolve and cleared
 * outright when a credential fails auth (`rotateSessionCredential`). A pin is the USER's
 * intent. Storing both in one row means rate-limit rotation silently overwrites the choice
 * the user made, and nothing is left to compare against, so the UI cannot say the account
 * changed under them. Two keys keeps the two facts separable, which is what makes the
 * divergence reportable instead of invisible.
 */
const SESSION_PIN_CACHE_PREFIX = "session:pin:";

/** How long a pin survives with no further use, matching the sticky record's window. */
const SESSION_PIN_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * How long an auth-death failover stays pending before it is dropped unannounced.
 *
 * The notice describes the request that is retrying right now. If no resolve lands inside this
 * window the retry was abandoned, and firing then would announce a move that never happened.
 */
const FAILOVER_NOTICE_WINDOW_MS = 60_000;

/**
 * How one provider's traffic is routed for one session: what the user chose, what is
 * actually serving, and why those can differ.
 */
export interface SessionCredentialRouting {
	provider: string;
	/**
	 * The account the user chose: their global `/account` selection for this provider, or a
	 * session pin when one is set (a pin outranks the global choice for that one session).
	 * Absent when they never chose.
	 */
	selectedCredentialId?: number;
	/**
	 * Credential the next request will use: the pin while it is usable, else the one that last
	 * served, else the selection this storage would make if the request went out now.
	 *
	 * Absent only when the provider holds no credential at all. It used to be absent whenever
	 * nothing had been spent yet, so a fresh session with three accounts had NOTHING that answered
	 * which one the next request goes to: the card showed three rows, none tagged, and the operator
	 * had to send a request to find out.
	 */
	activeCredentialId?: number;
	/**
	 * True when {@link activeCredentialId} is a PREDICTION rather than an observation.
	 *
	 * Set when no pin and no last-used record decided it, so the answer came from replaying the
	 * selection the next request would make. Surfaces must say which they are showing: "serving"
	 * describes traffic that has already gone somewhere, and claiming it before the first request
	 * of a session is a guess wearing the clothes of a fact. The prediction covers stickiness and
	 * rate-limit ordering, which are deterministic; a provider with an async usage-ranking strategy
	 * can still land elsewhere, and that is the honest reason the two are distinguished.
	 */
	activeIsPrediction?: boolean;
	/** Epoch ms the chosen credential becomes usable again, when it is rate-limit blocked. */
	selectedBlockedUntilMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Credential Types
// ─────────────────────────────────────────────────────────────────────────────

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
	source?: "login";
};

export type OAuthCredential = {
	type: "oauth";
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthCredentialEntry = AuthCredential | AuthCredential[];

export type AuthStorageData = Record<string, AuthCredentialEntry>;

/**
 * Cascade leg that supplies a provider's active credential, highest precedence
 * first — mirrors {@link AuthStorage.getApiKey}'s resolution order.
 */
export type CredentialOriginKind = "runtime" | "config" | "oauth" | "api_key" | "env" | "fallback";

/**
 * Structured provenance for a provider's auth, for UI that needs a machine
 * tag (the `/login` provider list) rather than the prose of
 * {@link AuthStorage.describeCredentialSource}.
 */
export interface CredentialOrigin {
	kind: CredentialOriginKind;
	/** Env var name when `kind === "env"` and a single named variable backs it. */
	envVar?: string;
}

/**
 * Serialized representation of AuthStorage for passing to subagent workers.
 * Contains only the essential credential data, not runtime state.
 */
export interface SerializedAuthStorage {
	credentials: Record<
		string,
		Array<{
			id: number;
			type: "api_key" | "oauth";
			data: Record<string, unknown>;
		}>
	>;
	runtimeOverrides?: Record<string, string>;
	dbPath?: string;
}

/**
 * Auth credential with database row ID for updates/deletes.
 * Wraps AuthCredential with storage metadata.
 */
export interface StoredAuthCredential {
	id: number;
	provider: string;
	credential: AuthCredential;
	disabledCause: string | null;
}

/** One in-memory rate-limit block: its deadline plus the clock reading that set it. */
interface InMemoryCredentialBlock {
	/** Epoch milliseconds the credential becomes usable again. */
	blockedUntilMs: number;
	/** Epoch milliseconds the block was set, used to detect a backward clock jump. */
	blockedAtMs: number;
}

/** One persisted rate-limit block: credential row id + provider-type key + optional scope. */
export interface StoredCredentialBlock {
	/** SQLite row id of the credential (auth_credentials.id). */
	credentialId: number;
	/** `${provider}:${credentialType}` — same value as AuthStorage's in-memory providerKey. */
	providerKey: string;
	/** Block scope (e.g. "tier:fable"); empty string = unscoped. Never NUL-delimited. */
	blockScope: string;
	/** Epoch milliseconds. */
	blockedUntilMs: number;
	/** Last row update timestamp in epoch milliseconds, when provided by the backing store. */
	updatedAtMs?: number;
}

/**
 * Per-credential health record returned by {@link AuthStorage.checkCredentials}.
 *
 * Use this to identify which credential in a multi-account pool is causing
 * auth errors. `ok` is tri-state:
 *
 * - `true` — credential authenticated against the provider's auth-verifying
 *   probe (today: the usage endpoint). For OAuth this also exercises refresh
 *   when the access token was expired.
 * - `false` — the probe rejected the credential (401/403/refresh failure/etc).
 *   `reason` carries the upstream error string.
 * - `null` — no probe is configured for this provider (or the configured
 *   probe doesn't support this credential type). The credential's auth
 *   status is unverifiable from here.
 */
export interface CredentialHealthResult {
	/** Database row id (matches {@link StoredAuthCredential.id}). */
	id: number;
	provider: string;
	type: AuthCredential["type"];
	/** OAuth email if known on the stored credential or surfaced by the probe. */
	email?: string;
	/** OAuth account id if known. */
	accountId?: string;
	/** Organization/workspace the credential is scoped to (Anthropic multi-subscription). */
	orgId?: string;
	orgName?: string;
	/** `true` when the refresh token lives on a remote broker (sentinel was present). */
	remoteRefresh?: true;
	ok: boolean | null;
	/** Failure / unverifiable reason; absent when `ok === true`. */
	reason?: string;
	/** Probe usage report (raw payload stripped) when `ok === true`. */
	report?: Omit<UsageReport, "raw">;
	/**
	 * Result of the optional end-to-end completion probe (see
	 * {@link CheckCredentialsOptions.completionProbe}). Absent when no probe was
	 * supplied. The completion probe exercises the provider's chat-completion
	 * endpoint with the credential's bearer bytes, which is a stricter signal
	 * than the usage endpoint (some providers happily 200 a `/usage` call while
	 * the chat endpoint 401s the same bearer).
	 */
	completion?: CredentialCompletionResult;
}

/**
 * Outcome of the end-to-end completion probe. `null` means the probe was
 * skipped (no bearer bytes were available — e.g. OAuth refresh failed
 * upstream of the probe).
 */
export interface CredentialCompletionResult {
	ok: boolean | null;
	/** Failure / unverifiable reason; absent when `ok === true`. */
	reason?: string;
	/** Probe model id used (carried back from the caller for display). */
	modelId?: string;
	/** Round-trip latency in milliseconds. */
	latencyMs?: number;
}

/**
 * Credential payload handed to {@link CompletionProbe}. For API-key
 * credentials only the bytes are exposed; for OAuth, every identity field
 * carried by the refreshed credential is included so the probe can compose
 * provider-specific apiKey shapes (e.g. GitHub Copilot / Google Gemini CLI
 * expect a JSON blob with `token` + `projectId`, not the raw access token).
 *
 * `refreshToken` may be {@link REMOTE_REFRESH_SENTINEL} when the credential
 * lives behind a broker; the chat endpoint never reads it, so the probe can
 * forward it verbatim into the structured shape without harm.
 */
export type CompletionProbeCredential =
	| { type: "api_key"; apiKey: string }
	| {
			type: "oauth";
			accessToken: string;
			refreshToken?: string;
			expiresAt?: number;
			accountId?: string;
			projectId?: string;
			email?: string;
			enterpriseUrl?: string;
			apiEndpoint?: string;
	  };

/**
 * Caller-supplied bearer probe. Receives the post-refresh credential for a
 * single row and reports whether a real chat-completion round-trip succeeds.
 * The check-credentials pipeline calls this AFTER any OAuth refresh so the
 * bytes match what a live request would send.
 */
export interface CompletionProbeInput {
	provider: Provider;
	credentialId: number;
	credential: CompletionProbeCredential;
	signal: AbortSignal;
}

export type CompletionProbe = (input: CompletionProbeInput) => Promise<CredentialCompletionResult>;

export interface CheckCredentialsOptions {
	signal?: AbortSignal;
	/** Per-credential probe timeout (ms). Defaults to the configured usage request timeout. */
	timeoutMs?: number;
	/**
	 * Probe only these credential row ids, instead of every active row.
	 *
	 * For a surface that re-probes ONE account: a card with nine accounts open costs nine network
	 * round-trips per refresh, and a user asking about one row has no reason to pay for the other
	 * eight or to wait behind them. An id that is not stored (a row a peer logged out between the
	 * render and the keypress) contributes no result rather than an error, because the caller's
	 * question about it is already answered: it is gone.
	 *
	 * Absent means every active row, which is what the whole-store callers want.
	 */
	credentialIds?: readonly number[];
	/** Provider → base URL override, same shape as {@link AuthStorage.fetchUsageReports}. */
	baseUrlResolver?: (provider: Provider) => string | undefined;
	/**
	 * Optional end-to-end probe. When provided, `checkCredentials` invokes it
	 * for every credential where a usable bearer is available (API key, or
	 * OAuth access token after refresh-on-expiry succeeded). The result lands
	 * on {@link CredentialHealthResult.completion}.
	 *
	 * The probe runs INDEPENDENTLY of whether a {@link UsageProvider} is
	 * configured: providers without a usage endpoint still benefit from the
	 * extra signal. The probe is NOT invoked when OAuth refresh fails — the
	 * bytes would be stale anyway and the upstream failure is already captured
	 * on `reason`.
	 */
	completionProbe?: CompletionProbe;
	/** Per-credential completion probe timeout (ms). Defaults to `timeoutMs`. */
	completionTimeoutMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth Broker Snapshot Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sentinel value placed in OAuth `refresh` fields when a credential is shared
 * via {@link AuthStorage.exportSnapshot}. Refresh tokens never leave the broker;
 * clients must call back to refresh.
 */
export const REMOTE_REFRESH_SENTINEL = "__remote__" as const;
export type RemoteRefreshSentinel = typeof REMOTE_REFRESH_SENTINEL;

/** OAuth credential with refresh token replaced by the broker sentinel. */
export type RemoteOAuthCredential = Omit<OAuthCredential, "refresh"> & {
	refresh: RemoteRefreshSentinel;
};

/** Discriminated credential payload as published by the broker. */
export type SnapshotCredential = ApiKeyCredential | RemoteOAuthCredential;

export interface AuthCredentialSnapshotEntry {
	id: number;
	provider: string;
	credential: SnapshotCredential;
	identityKey: string | null;
}

/**
 * Wire-shaped snapshot exported by {@link AuthStorage.exportSnapshot} and
 * served by the auth-broker server on `GET /v1/snapshot`.
 */
export interface AuthCredentialSnapshot {
	generation: number;
	generatedAt: number;
	credentials: AuthCredentialSnapshotEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// AuthCredentialStore interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persistence abstraction consumed by {@link AuthStorage}.
 *
 * Concrete implementations:
 * - {@link SqliteAuthCredentialStore} — local SQLite-backed store (default).
 * - `RemoteAuthCredentialStore` from `./auth-broker` — client-side snapshot of
 *   a remote broker; mutating methods (`replace*`, `upsert*`, `delete*ForProvider`)
 *   throw because login flows route through the broker, not the client.
 */
export interface CredentialRefreshLeaseFence {
	owner: string;
	nowMs: number;
}

export interface AuthCredentialStore {
	close(): void;
	/** Optional hook to notify the underlying store that usage report cache is stale. */
	invalidateUsageCache?(signal?: AbortSignal): Promise<void>;
	listAuthCredentials(provider?: string): StoredAuthCredential[];
	updateAuthCredential(id: number, credential: AuthCredential): void;
	/**
	 * Persist a refreshed credential AND clear any `disabled_cause` on the row.
	 *
	 * A successful refresh is proof the grant is alive, so a row a peer disabled on
	 * a now-superseded token must come back. Without this, `updateAuthCredential`
	 * writes a live token onto a row still flagged disabled, `listAuthCredentials`
	 * filters it out, and the user is "logged out" with a working token sitting
	 * right there.
	 */
	updateAuthCredentialEnabling?(id: number, credential: AuthCredential): void;
	/**
	 * Read one row by id INCLUDING disabled rows.
	 *
	 * `listAuthCredentials` deliberately hides disabled rows, so it cannot answer
	 * "did a peer already rotate this credential?" during a refresh race — the peer's
	 * winning row may be exactly the one that got disabled. This is the only reader
	 * that can see it.
	 */
	readAuthCredentialById?(id: number): StoredAuthCredential | undefined;
	/**
	 * List the DISABLED rows for a provider, newest disable first.
	 *
	 * `listAuthCredentials` hides them, which is right for resolution: a disabled
	 * credential must never be handed out. It is wrong for reporting. A user whose
	 * only credential was disabled by a failed refresh has the same view as a user
	 * who never signed in, so they are told "no API key found" and sent to log in
	 * again with nothing saying what happened to the login they had.
	 */
	listDisabledAuthCredentials?(provider?: string): StoredAuthCredential[];
	deleteAuthCredential(id: number, disabledCause: string): void;
	tryDisableAuthCredentialIfMatches(
		id: number,
		expectedData: string,
		disabledCause: string,
		lease?: CredentialRefreshLeaseFence,
	): boolean;
	tryUpdateAuthCredentialIfMatches?(
		id: number,
		expectedData: string,
		credential: AuthCredential,
		lease?: CredentialRefreshLeaseFence,
	): boolean;
	replaceAuthCredentialsForProvider(provider: string, credentials: AuthCredential[]): StoredAuthCredential[];
	upsertAuthCredentialForProvider(provider: string, credential: AuthCredential): StoredAuthCredential[];
	deleteAuthCredentialsForProvider(provider: string, disabledCause: string): void;
	getCache(key: string, options?: { includeExpired?: boolean }): string | null;
	setCache(key: string, value: string, expiresAtSec: number): void;
	/** Drop all cache rows whose keys start with the supplied prefix. */
	deleteCachePrefix?(prefix: string): void;
	cleanExpiredCache(): void;
	/** Non-expired block for one (credential, providerKey, scope) key, or undefined. */
	getCredentialBlock?(credentialId: number, providerKey: string, blockScope: string): number | undefined;
	/** Earliest time a shared-store block should be eligible for live-usage reconciliation. */
	getCredentialBlockReconcileAfter?(credentialId: number, providerKey: string, blockScope: string): number | undefined;
	/** Upsert with MAX semantics: keep the later blockedUntilMs on conflict. */
	upsertCredentialBlock?(block: StoredCredentialBlock): void;
	/** Drop every block row for a credential (all providerKeys/scopes). */
	deleteCredentialBlocks?(credentialId: number): void;
	/** Prune rows with blocked_until_ms <= nowMs. */
	cleanExpiredCredentialBlocks?(nowMs: number): void;
	/** List non-expired blocks for broker snapshots. */
	listCredentialBlocks?(credentialIds: readonly number[]): StoredCredentialBlock[];
	/**
	 * User-chosen account display names, keyed by the stable identity from
	 * {@link resolveAccountNameIdentity}. Optional: the remote-broker store has no
	 * local table, and a store without them simply has no names to show.
	 */
	getAccountName?(identity: string): string | undefined;
	listAccountNames?(): Array<{ identity: string; name: string }>;
	setAccountName?(identity: string, name: string): void;
	deleteAccountName?(identity: string): void;
	/**
	 * The account chosen for a provider, keyed by the same stable identity as the names table.
	 *
	 * GLOBAL and durable by design: the credentials themselves are shared by every profile and
	 * every session on the machine, so the account you picked has to be too. Keyed by identity
	 * rather than row id so a re-login, which writes a new row, keeps the choice.
	 *
	 * Optional, like the names: the remote-broker store keeps no local table, and a store without
	 * it simply has no persisted choice, so selection lives for the process and says so.
	 */
	getProviderSelection?(provider: string): string | undefined;
	setProviderSelection?(provider: string, identity: string): void;
	clearProviderSelection?(provider: string): void;
	tryAcquireCredentialRefreshLease?(credentialId: number, owner: string, expiresAtMs: number): boolean;
	getCredentialRefreshLeaseExpiresAt?(credentialId: number): number | undefined;
	releaseCredentialRefreshLease?(credentialId: number, owner: string): void;
	renewCredentialRefreshLease?(credentialId: number, owner: string, expiresAtMs: number): boolean;
	/**
	 * Append usage-limit snapshots for trend history. Optional: stores without
	 * durable storage (e.g. the broker remote store) omit it and recording is
	 * skipped — the broker host records into its own database instead.
	 */
	recordUsageSnapshots?(entries: UsageHistoryEntry[]): void;
	/** Append observed request costs for providers without upstream usage APIs. */
	recordUsageCosts?(entries: UsageCostHistoryEntry[]): void;
	/** Read observed request costs, oldest first. */
	listUsageCosts?(query?: UsageCostHistoryQuery): UsageCostHistoryEntry[];
	/** Read recorded usage-limit snapshots, oldest first. */
	listUsageHistory?(query?: UsageHistoryQuery): UsageHistoryEntry[];
	/**
	 * Optional store-supplied OAuth refresh. When present, `AuthStorage` uses
	 * it before the per-provider local refresh path. `RemoteAuthCredentialStore`
	 * implements this against the broker; SQLite stores leave it undefined.
	 *
	 * Precedence: `AuthStorageOptions.refreshOAuthCredential` > this hook > local.
	 *
	 * `signal` propagates the agent's cancel (ESC, request abort, …) all the
	 * way to the broker fetch so a hung connection can't strand the caller
	 * for `timeoutMs * (maxRetries + 1)`.
	 */
	refreshOAuthCredential?(
		provider: Provider,
		credentialId: number,
		credential: OAuthCredential,
		signal?: AbortSignal,
	): Promise<OAuthCredentials>;
	/**
	 * Optional async pre-read hook invoked after AuthStorage selects a stored
	 * credential but before it returns that credential for an outbound request.
	 * Remote broker stores use this to wait out imminent rotations and refresh
	 * their local snapshot before the caller sees a stale access token.
	 */
	prepareForRequest?(credentialId: number, opts?: { signal?: AbortSignal }): Promise<boolean | undefined>;
	/**
	 * Optional store-supplied aggregate usage fetch. When present, `AuthStorage`
	 * routes `fetchUsageReports()` here instead of fanning out per-credential.
	 * `RemoteAuthCredentialStore` proxies to the broker (whose datacenter IP
	 * isn't rate-limited like a heavy residential client).
	 *
	 * Precedence: `AuthStorageOptions.fetchUsageReports` > this hook > local fan-out.
	 *
	 * `signal` propagates the agent's cancel down to the broker fetch.
	 */
	fetchUsageReports?(signal?: AbortSignal): Promise<UsageReport[] | null>;
	/**
	 * Optional store-supplied per-credential usage report lookup. When present,
	 * `AuthStorage` consults this before its own per-credential upstream fetch
	 * (`#getUsageReport`). `RemoteAuthCredentialStore` implements this against
	 * the broker's aggregate `/v1/usage` (one coalesced round-trip shared across
	 * all callers) so multi-credential ranking on the client never hits the
	 * upstream provider's rate-limited usage endpoint from the laptop IP.
	 *
	 * Returning `null` is authoritative — `AuthStorage` does NOT fall back to
	 * the local fetch path. The store hook owns the decision, since falling
	 * back would re-introduce the per-IP rate-limit problem the broker exists
	 * to avoid.
	 *
	 * `signal` propagates the agent's cancel down to the broker fetch.
	 */
	getUsageReport?(provider: Provider, credential: OAuthCredential, signal?: AbortSignal): Promise<UsageReport | null>;
	/**
	 * Optional store hook to ingest a parsed provider usage report for one OAuth
	 * credential. Remote broker stores use this to overlay header-derived limits
	 * onto their cached aggregate `/v1/usage` response without mutating broker
	 * state.
	 */
	ingestUsageReport?(provider: Provider, credential: OAuthCredential, report: UsageReport): boolean;
	/**
	 * Optional store hook to invalidate a specific credential after the upstream
	 * provider returned 401 on a supposedly-fresh key. Remote stores force the
	 * broker to re-issue the row; local stores can leave it undefined and let
	 * {@link AuthStorage.invalidateCredentialMatching} fall back to `reload()`.
	 */
	markCredentialSuspect?(credentialId: number, opts?: { signal?: AbortSignal }): Promise<void>;
	/**
	 * Optional async write hook for upserting a single credential. When present,
	 * `AuthStorage.#upsertOAuthCredential` routes through this instead of the
	 * sync `upsertAuthCredentialForProvider`. `RemoteAuthCredentialStore` uses
	 * it to send the upsert to the broker via `POST /v1/credential`.
	 *
	 * Implementations MUST update the in-memory snapshot before returning so the
	 * post-write read path is consistent.
	 */
	upsertAuthCredentialRemote?(provider: string, credential: AuthCredential): Promise<StoredAuthCredential[]>;
	/**
	 * Optional async write hook for replace-all semantics (e.g. API-key login
	 * overwriting any previous keys for the same provider). When present,
	 * `AuthStorage.set` routes through this instead of the sync
	 * `replaceAuthCredentialsForProvider`.
	 */
	replaceAuthCredentialsRemote?(provider: string, credentials: AuthCredential[]): Promise<StoredAuthCredential[]>;
	/**
	 * Optional async write hook for disabling one stored credential. Remote stores
	 * use it to await broker persistence before AuthStorage updates its snapshot.
	 */
	deleteAuthCredentialRemote?(id: number, disabledCause: string): Promise<boolean>;
	/**
	 * Optional async write hook for clearing every credential for a provider
	 * (logout). When present, `AuthStorage.remove` routes through this instead
	 * of the sync `deleteAuthCredentialsForProvider`.
	 */
	deleteAuthCredentialsRemote?(provider: string, disabledCause: string): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// AuthStorage Options
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Event payload describing a credential that was just soft-disabled.
 *
 * Today the only call site is OAuth refresh failures with a definitive cause
 * (`invalid_grant`, `401/403` not from a network blip, etc.) — the
 * disabled_cause string is the verbatim error captured for forensics.
 *
 * Subscribers can use this to surface a notification, banner, or auto-launch
 * a re-login flow instead of letting the credential silently disappear.
 */
export interface CredentialDisabledEvent {
	provider: string;
	disabledCause: string;
}

/**
 * Event payload describing an automatic move from one account to another.
 *
 * Emitted only for AUTH DEATH — a credential a request cannot be served with at all (revoked
 * token, `invalid_grant`, a row disabled underneath us). Quota and rate-limit movement never
 * emits this, because that movement is gated by the load-balancing setting and, when it is on,
 * is the routine thing the operator asked for rather than news.
 *
 * Both accounts are named: a notice that says only "switched account" leaves the operator unable
 * to tell which credential died or which one is now spending, which is the whole content of the
 * event.
 */
export interface CredentialFailoverEvent {
	provider: string;
	/** The account that could no longer serve, and why. */
	from: { credentialId: number; label: string };
	/** The account routing moved to. */
	to: { credentialId: number; label: string };
	cause: string;
}

/**
 * Event payload for the move that did NOT happen: this account's quota window is exhausted and
 * sibling accounts are sitting unblocked, but `accounts.loadBalancing` is off so nothing moved.
 *
 * The exact counterpart of {@link CredentialFailoverEvent}. Auth death moves without asking and
 * says so; quota exhaustion respects the setting and, until now, said nothing at all: the turn
 * simply waited out a window that can be hours long, next to accounts that could have served it.
 * That silence is what makes the setting undiscoverable, because the one moment it is worth
 * knowing about is the moment it costs something.
 *
 * Emitted at most once per exhausted window per account, so a turn that retries does not repeat
 * itself. Never emitted when the setting is ON (the move is the routine thing the operator asked
 * for) and never when no sibling could have served (then the wait is the provider's, not a
 * choice anyone made).
 */
export interface UsageLimitWithheldEvent {
	provider: string;
	/** The account whose window is exhausted. */
	account: { credentialId: number; label: string };
	/** Stored, same-type, unblocked accounts that would have served this request. Always >= 1. */
	idleSiblings: number;
	/** Epoch ms when this account's own window is expected back. */
	retryAtMs: number;
}

export type AuthStorageOptions = {
	usageProviderResolver?: (provider: Provider) => UsageProvider | undefined;
	rankingStrategyResolver?: (provider: Provider) => CredentialRankingStrategy | undefined;
	usageFetch?: typeof fetch;
	usageRequestTimeoutMs?: number;
	usageLogger?: UsageLogger;
	/**
	 * Resolve a config value (API key, header value, etc.) to an actual value.
	 * - coding-agent injects its resolveConfigValue (supports "!command" syntax via veyyon-natives)
	 * - Default: checks environment variable first, then treats as literal
	 */
	configValueResolver?: (config: string) => Promise<string | undefined>;
	/**
	 * Optional callback fired when AuthStorage automatically disables a
	 * credential because something detected it as no longer usable — today
	 * that's the OAuth refresh-failure path in `getApiKey`. NOT fired for
	 * user-initiated `remove()` (the user already knows) or dedup of
	 * duplicate credentials (uninteresting hygiene).
	 */
	onCredentialDisabled?: (event: CredentialDisabledEvent) => void | Promise<void>;
	/**
	 * Fired when auth death moved a provider from one account to another. See
	 * {@link CredentialFailoverEvent}; never fired for quota or rate-limit movement.
	 */
	onCredentialFailover?: (event: CredentialFailoverEvent) => void | Promise<void>;
	/**
	 * Fired when quota exhaustion could have moved to an idle sibling and the load-balancing
	 * setting withheld it. See {@link UsageLimitWithheldEvent}.
	 */
	onUsageLimitWithheld?: (event: UsageLimitWithheldEvent) => void | Promise<void>;
	/**
	 * Whether QUOTA and RATE-LIMIT exhaustion may move a provider to a different account.
	 *
	 * Defaults to `true` so every existing embedder — the auth broker, the gateway, the SDK —
	 * keeps the behaviour it has today. The coding-agent passes the operator's
	 * `accounts.loadBalancing` setting, which defaults to OFF: spreading one operator's work
	 * across their accounts is a choice with consequences they must opt into, not a default.
	 *
	 * This gates ONLY exhaustion-driven movement. Auth death is never gated: a revoked
	 * credential cannot serve the request at all, so refusing to move would just fail.
	 *
	 * A resolver rather than a plain boolean is accepted because the setting is live-editable;
	 * reading it per decision means a `/settings` change takes effect without a restart.
	 */
	loadBalancing?: boolean | (() => boolean);
	/**
	 * Override OAuth refresh. When set, `AuthStorage` calls this instead of the
	 * per-provider local refresh function. Receives the credential id so the
	 * implementation can address remote credentials.
	 *
	 * Must return updated {@link OAuthCredentials} with at least `access` and
	 * `expires`. `refresh` may be an opaque sentinel (e.g. `"__remote__"`) when
	 * the actual refresh token never leaves the broker.
	 */
	refreshOAuthCredential?: (
		provider: Provider,
		credentialId: number,
		credential: OAuthCredential,
		signal?: AbortSignal,
	) => Promise<OAuthCredentials>;
	/**
	 * Human-readable description of the credential store backing this
	 * AuthStorage instance. Surfaced through {@link AuthStorage.describeCredentialSource}
	 * so the TUI can show where a token came from (broker URL or local SQLite path).
	 *
	 * Examples:
	 * - `"local ~/.veyyon/agent/agent.db"`
	 * - `"broker http://veyyon.internal:8765"`
	 */
	sourceLabel?: string;
	/**
	 * Override `fetchUsageReports`. When set, `AuthStorage.fetchUsageReports`
	 * calls this instead of fanning out per-credential. The primary use case is
	 * routing through a broker that egresses from a less-throttled IP — e.g. a
	 * residential laptop trips Anthropic's per-IP rate limit on the usage
	 * endpoint and drops 2-of-5 credentials, while the VPS broker gets all 5.
	 *
	 * Implementations may return null when no usage data is available; the
	 * AuthStorage caller surfaces that to its own consumer unchanged.
	 */
	fetchUsageReports?: (signal?: AbortSignal) => Promise<UsageReport[] | null>;
};

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

const USAGE_CACHE_PREFIX = "usage_cache:";
// The two usage-row constants live in `auth-credential-rows.ts`; both halves of the split read them.
const USAGE_HEADER_INGEST_INTERVAL_MS = 60_000;
const USAGE_LAST_GOOD_RETENTION_MS = 24 * 60 * 60_000;
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
const USAGE_REPORT_CACHE_KEY_VERSION_OVERRIDES: Partial<Record<Provider, number>> = {
	"google-antigravity": 2,
	zai: 2,
	// v2: cache identity gained an `org:` component so two subscriptions on one
	// account email stop sharing a slot. The bump also retires pre-org entries —
	// otherwise an org-less credential could replay another org's cached pool
	// (incl. the 24h last-good fallback) via the old bare email/account key.
	anthropic: 2,
};
const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 10_000;
/**
 * Refresh OAuth access tokens this many ms before their stated expiry. The
 * skew exists so callers downstream of {@link AuthStorage} (stream providers,
 * usage probes, web_search) never observe a credential that is expired or
 * about to expire mid-request — there's a single rotation point and everyone
 * downstream trusts the token they receive.
 *
 * Set to 60s: comfortably absorbs request RTT + a clock-skew window without
 * triggering a refresh on every request. Provider token endpoints typically
 * mint access tokens with 30-60min lifetimes, so refreshing 60s early changes
 * the rotation cadence by <4%.
 */
const OAUTH_REFRESH_SKEW_MS = 60_000;
const OAUTH_REFRESH_LEASE_TTL_MS = 15_000;
const OAUTH_REFRESH_LEASE_POLL_MS = 50;
const OAUTH_REFRESH_LEASE_RENEW_MS = 5_000;
const OAUTH_REFRESH_OPERATION_TIMEOUT_MS = 10_000;
/**
 * Cap on the buffered credential_disabled backlog held while no handler is attached.
 * In practice the backlog is 0–N where N ≈ active providers (≤ ~20). The cap exists so
 * pathological detach-without-reattach loops can't grow memory unboundedly.
 */
const MAX_PENDING_DISABLED_EVENTS = 32;
/**
 * Cap on remembered withheld-quota notice keys (one per exhausted window per account). Sized like
 * the disabled-event backlog: a handful of accounts times a handful of windows a day.
 */
const MAX_WITHHELD_QUOTA_NOTICES = 64;

// Re-exported from the error module (its new home) to preserve the public
// `@veyyon/ai` entrypoint and the in-module call sites below.
export { isDefinitiveOAuthFailure } from "./error/auth-classify";

/**
 * Outcome of {@link AuthStorage.markUsageLimitReached}.
 *
 * `switched` is `true` when an unblocked same-type sibling credential is
 * available right now, so the caller can retry immediately and the next
 * `getApiKey` will hand it out. When `false`, `retryAtMs` (epoch ms) carries
 * the earliest moment any same-type sibling's temporary block expires —
 * callers should prefer waiting until then over the provider's (often
 * multi-hour) retry-after when it is sooner. `retryAtMs` is `undefined` when
 * no sibling credentials exist at all, or when the session has no tracked
 * credential to rotate away from.
 *
 * A gate-off return carries no sibling count. The fact that idle siblings were
 * withheld is announced through {@link UsageLimitWithheldEvent} instead, which
 * has the one thing a return value cannot: a dedupe key, so a turn that retries
 * into the same exhausted window states it once.
 */
export interface UsageLimitMarkResult {
	switched: boolean;
	retryAtMs?: number;
}

type UsageCacheEntry<T> = {
	value: T;
	expiresAt: number;
};

interface UsageCache {
	get<T>(key: string): UsageCacheEntry<T> | undefined;
	getStale<T>(key: string): UsageCacheEntry<T> | undefined;
	set<T>(key: string, entry: UsageCacheEntry<T>): void;
	cleanup?(): void;
}

type UsageRequestDescriptor = {
	provider: Provider;
	credential: UsageCredential;
	baseUrl?: string;
};

type AuthApiKeyOptions = {
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
type OAuthResolutionResult = { apiKey: string; credential: OAuthCredential; credentialId?: number };

/**
 * Refreshed OAuth access plus identity metadata returned by
 * {@link AuthStorage.getOAuthAccess}. Callers that authenticate via a bearer
 * AND need the credential's identity (Codex `chatgpt-account-id`, Google
 * `projectId`, GitHub `enterpriseUrl`) consume this shape directly; the
 * refresh slot is deliberately omitted because rotating refresh tokens never
 * leave {@link AuthStorage}.
 */
export interface OAuthAccess {
	accessToken: string;
	credentialId?: number;
	accountId?: string;
	email?: string;
	projectId?: string;
	enterpriseUrl?: string;
	apiEndpoint?: string;
	/** Organization/workspace the credential is scoped to (Anthropic multi-subscription). */
	orgId?: string;
	orgName?: string;
}

/**
 * Identity slice of the credential a successful {@link AuthStorage.login}
 * stored — lets callers confirm WHICH account (and for Anthropic, which
 * organization/subscription) was added, without exposing tokens.
 */
export interface OAuthLoginIdentity {
	type: "oauth" | "api_key";
	email?: string;
	accountId?: string;
	orgId?: string;
	orgName?: string;
	/**
	 * Row id the credential landed on, so the caller can act on THAT account: name it, select it,
	 * or report it. Absent only when the write went somewhere the row cannot be identified
	 * afterwards (a remote store that answers with a different row set than it was given).
	 */
	credentialId?: number;
}

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

function matchStoredCredentialId(
	stored: readonly { id: number; credential: AuthCredential }[],
	written: AuthCredential,
): number | undefined {
	const secret = storedCredentialSecret(written);
	return stored.find(entry => storedCredentialSecret(entry.credential) === secret)?.id;
}

export interface OAuthAccessFailure {
	credentialId?: number;
	accountId?: string;
	email?: string;
	projectId?: string;
	enterpriseUrl?: string;
	apiEndpoint?: string;
	/** Organization/workspace the credential is scoped to (Anthropic multi-subscription). */
	orgId?: string;
	orgName?: string;
	error: string;
}

/**
 * Identity of the OAuth credential a session is currently routed to. Read-only
 * display/metadata shape: `accountId` is the provider's account UUID, `email`
 * the user-facing login, `projectId` the GCP-style project for providers that
 * key usage on it (Gemini CLI / Antigravity).
 */
export interface OAuthAccountIdentity {
	accountId?: string;
	email?: string;
	projectId?: string;
	/** Organization/workspace the credential is scoped to (Anthropic multi-subscription). */
	orgId?: string;
	orgName?: string;
}

export type OAuthAccessResolution = ({ ok: true } & OAuthAccess) | ({ ok: false } & OAuthAccessFailure);

/**
 * Read-only identity of one stored OAuth account, in stable storage order.
 * Returned by {@link AuthStorage.listOAuthAccounts}; `position` (0-based) is the
 * selector accepted by {@link AuthStorage.getOAuthAccessAt}.
 */
export interface OAuthAccountSummary {
	position: number;
	credentialId: number;
	accountId?: string;
	email?: string;
	projectId?: string;
	enterpriseUrl?: string;
	/** Organization/workspace the credential is scoped to (Anthropic multi-subscription). */
	orgId?: string;
	orgName?: string;
}
export interface InvalidateCredentialMatchingOptions {
	signal?: AbortSignal;
	sessionId?: string;
}

/** Options for refreshing one stored OAuth row through durable ownership. */
export interface StoredOAuthRefreshOptions<T extends OAuthCredential = OAuthCredential> {
	observedCredential?: T;
	credentialFromRow: (credential: OAuthCredential) => T | undefined;
	forceRefresh?: boolean;
	canRefresh?: (credential: T) => boolean;
	refreshSkewMs?: number;
	signal?: AbortSignal;
	keepCredentialOnRefreshFailure?: boolean | ((error: unknown) => boolean);
	onRefreshFailure?: (error: unknown) => void;
	refreshTimeoutMs?: number;
	refresh: (credential: T, signal?: AbortSignal) => Promise<OAuthCredentials>;
	mergeRefreshedCredential?: (credential: T, refreshed: OAuthCredentials) => T;
	isDefinitiveFailure?: (error: unknown) => boolean;
	disabledCause?: (error: unknown) => string;
}

/** Result of a stored OAuth refresh attempt. */
export interface StoredOAuthRefreshResult<T extends OAuthCredential = OAuthCredential> {
	credential: T | undefined;
	refreshed: boolean;
	removed: boolean;
}

/**
 * Identifies which stored account to redeem a saved rate-limit reset for.
 * Any one field is enough; `credentialId` is the most precise.
 */
export interface ResetCreditTarget {
	credentialId?: number;
	accountId?: string;
	email?: string;
}

/** Outcome of {@link AuthStorage.redeemResetCredit}. */
export interface ResetCreditRedeemOutcome {
	/** `true` only when a reset was actually applied (`code === "reset"`). */
	ok: boolean;
	/**
	 * Result code. Backend codes: `reset` (success), `already_redeemed`,
	 * `no_credit`, `nothing_to_reset`. Locally-synthesized: `no_account`
	 * (target not found), `account_unavailable` (token refresh failed),
	 * `http_<status>` (unexpected HTTP).
	 */
	code: CodexResetConsumeCode;
	accountId?: string;
	email?: string;
	/** The credit that was spent (when one was). */
	creditId?: string;
}

/** One stored account's live saved-reset status, from {@link AuthStorage.listResetCredits}. */
export interface ResetCreditAccountStatus {
	credentialId?: number;
	accountId?: string;
	email?: string;
	/** Resets redeemable for this account right now (live, not cached). */
	availableCount: number;
	credits: CodexResetCredit[];
	/** Whether this is the given session's active account. */
	active: boolean;
	/** Set when the account's token refresh or list call failed. */
	error?: string;
}

function isAbortSignalOption(
	value: InvalidateCredentialMatchingOptions | AbortSignal | undefined,
): value is AbortSignal {
	return typeof value === "object" && value !== null && "aborted" in value && "addEventListener" in value;
}

type OpenAICodexPlanRequirement = "none" | "paid" | "pro";
type OpenAICodexPlanClass = "free" | "paid" | "pro" | "unknown";

const GPT_56_PAID_CODEX_MODEL_PATTERN = /^gpt-5\.6-(?:sol|luna)(?:-pro)?$/;
const OPENAI_CODEX_PRO_PLAN_TOKENS: Record<string, true> = {
	pro: true,
};
const OPENAI_CODEX_PAID_PLAN_TOKENS: Record<string, true> = {
	plus: true,
	business: true,
	team: true,
	enterprise: true,
	edu: true,
	education: true,
	teacher: true,
	teachers: true,
	health: true,
	gov: true,
	government: true,
};
const OPENAI_CODEX_FREE_PLAN_TOKENS: Record<string, true> = {
	free: true,
	go: true,
};

/**
 * Account tier needed for model-aware Codex OAuth routing.
 *
 * GPT-5.6 Terra (including its local pro-mode alias) remains available on every
 * plan. Sol and Luna pro-mode aliases inherit their base models' paid tier;
 * only Spark currently has a documented Pro-plan preference in Codex.
 */
function resolveOpenAICodexPlanRequirement(provider: string, modelId: string | undefined): OpenAICodexPlanRequirement {
	if (provider !== "openai-codex" || typeof modelId !== "string") return "none";
	const separator = modelId.lastIndexOf("/");
	const bareModelId = (separator === -1 ? modelId : modelId.slice(separator + 1)).toLowerCase();
	if (bareModelId.includes("-spark")) return "pro";
	if (bareModelId === "gpt-5.6" || GPT_56_PAID_CODEX_MODEL_PATTERN.test(bareModelId)) return "paid";
	return "none";
}

function getUsagePlanType(report: UsageReport | null): string | undefined {
	const metadata = report?.metadata;
	if (!metadata) return undefined;
	const planType = metadata.planType;
	if (typeof planType !== "string") return undefined;
	const normalized = planType
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
	return normalized.startsWith("chatgpt_") ? normalized.slice("chatgpt_".length) : normalized;
}

function classifyOpenAICodexPlan(report: UsageReport | null): OpenAICodexPlanClass {
	const planType = getUsagePlanType(report);
	if (!planType) return "unknown";
	// Pro Lite is a paid Codex tier, but does not imply full Pro-only model access.
	if (planType === "prolite" || planType === "pro_lite") return "paid";
	const tokens = planType.split("_");
	if (tokens.some(token => OPENAI_CODEX_PRO_PLAN_TOKENS[token] === true)) return "pro";
	if (tokens.some(token => OPENAI_CODEX_PAID_PLAN_TOKENS[token] === true)) return "paid";
	if (tokens.some(token => OPENAI_CODEX_FREE_PLAN_TOKENS[token] === true)) return "free";
	return "unknown";
}

function getOpenAICodexPlanEligibility(
	report: UsageReport | null,
	requirement: OpenAICodexPlanRequirement,
): boolean | undefined {
	if (requirement === "none") return true;
	const planClass = classifyOpenAICodexPlan(report);
	if (planClass === "unknown") return undefined;
	return requirement === "paid" ? planClass !== "free" : planClass === "pro";
}

function getOpenAICodexPlanPriority(report: UsageReport | null, requirement: OpenAICodexPlanRequirement): number {
	const eligibility = getOpenAICodexPlanEligibility(report, requirement);
	return eligibility === true ? 0 : eligibility === undefined ? 1 : 2;
}

function compareUsageRankingMetric(left: number, right: number): number {
	if (left === right) return 0;
	if (!Number.isFinite(left) || !Number.isFinite(right)) return left < right ? -1 : 1;
	const delta = left - right;
	const tolerance = Math.max(USAGE_RANKING_METRIC_EPSILON, Math.max(Math.abs(left), Math.abs(right)) * 0.000001);
	return Math.abs(delta) <= tolerance ? 0 : delta;
}

function resolveDefaultUsageProvider(provider: Provider): UsageProvider | undefined {
	return resolveRegisteredUsageProvider(provider);
}

function resolveDefaultRankingStrategy(provider: Provider): CredentialRankingStrategy | undefined {
	return resolveRegisteredRankingStrategy(provider);
}

function parseUsageCacheEntry<T>(raw: string): UsageCacheEntry<T> | undefined {
	try {
		const parsed = JSON.parse(raw) as { value?: T; expiresAt?: unknown };
		const expiresAt = typeof parsed.expiresAt === "number" ? parsed.expiresAt : undefined;
		if (!expiresAt || !Number.isFinite(expiresAt)) return undefined;
		return { value: parsed.value as T, expiresAt };
	} catch {
		// A cache entry we cannot read is a cache MISS, which is the same answer an absent entry gives and
		// the caller handles by fetching fresh. Never a wrong answer, only a slower one.
		return undefined;
	}
}

/**
 * Race `promise` against `signal`, rejecting only this caller when the signal
 * fires. The underlying promise keeps running so other awaiters on the same
 * single-flight fetch aren't punished by a peer's cancel.
 */
function raceUsageWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new AIError.RequestAbortError("usage fetch aborted"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => {
			signal.removeEventListener("abort", onAbort);
			reject(new AIError.RequestAbortError("usage fetch aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			value => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			err => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}

function raceCredentialRefreshWithSignal<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	message = "credential refresh aborted",
): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new AIError.RequestAbortError(message));
	const abort = Promise.withResolvers<never>();
	const onAbort = (): void => abort.reject(new AIError.RequestAbortError(message));
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([promise, abort.promise]).finally(() => {
		signal.removeEventListener("abort", onAbort);
	});
}

function authCredentialEquals(left: AuthCredential, right: AuthCredential): boolean {
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

function storedCredentialArraysEqual(left: StoredCredential[], right: StoredCredential[]): boolean {
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
// Usage Cache (backed by AuthCredentialStore)
// ─────────────────────────────────────────────────────────────────────────────

class AuthStorageUsageCache implements UsageCache {
	constructor(private store: AuthCredentialStore) {}

	get<T>(key: string): UsageCacheEntry<T> | undefined {
		const raw = this.store.getCache(`${USAGE_CACHE_PREFIX}${key}`);
		if (!raw) return undefined;
		return parseUsageCacheEntry<T>(raw);
	}

	getStale<T>(key: string): UsageCacheEntry<T> | undefined {
		const raw = this.store.getCache(`${USAGE_CACHE_PREFIX}${key}`, { includeExpired: true });
		if (!raw) return undefined;
		return parseUsageCacheEntry<T>(raw);
	}

	set<T>(key: string, entry: UsageCacheEntry<T>): void {
		const payload = JSON.stringify({ value: entry.value, expiresAt: entry.expiresAt });
		const durableExpiresAt =
			entry.value === null ? entry.expiresAt : Math.max(entry.expiresAt, Date.now() + USAGE_LAST_GOOD_RETENTION_MS);
		this.store.setCache(`${USAGE_CACHE_PREFIX}${key}`, payload, Math.floor(durableExpiresAt / 1000));
	}

	cleanup(): void {
		this.store.cleanExpiredCache();
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory representation
// ─────────────────────────────────────────────────────────────────────────────

type StoredCredential = { id: number; credential: AuthCredential };
type CredentialSelection<T extends AuthCredential> = { credential: T; index: number };
type OAuthSelection = CredentialSelection<OAuthCredential>;
type ApiKeySelection = CredentialSelection<ApiKeyCredential>;
type StoredOAuthSelection = { credentialId: number; credential: OAuthCredential; index: number };

type UsageCandidate<T extends AuthCredential> = {
	selection: CredentialSelection<T>;
	usage: UsageReport | null;
	usageChecked: boolean;
};

type OAuthCandidate = UsageCandidate<OAuthCredential>;
type ApiKeyCandidate = UsageCandidate<ApiKeyCredential>;
type UsageRankingResult<T extends AuthCredential> = UsageCandidate<T> & { blockedUntil: number | undefined };

type UsageRankedCandidate<T extends AuthCredential> = UsageCandidate<T> & {
	blocked: boolean;
	blockedUntil?: number;
	hasPriorityBoost: boolean;
	planPriority: number;
	secondaryUsed: number;
	secondaryRequiredDrain: number;
	primaryUsed: number;
	primaryRequiredDrain: number;
	orderPos: number;
};
type RankedOAuthCandidate = UsageRankedCandidate<OAuthCredential>;
type RankedApiKeyCandidate = UsageRankedCandidate<ApiKeyCredential>;

// ─────────────────────────────────────────────────────────────────────────────
// AuthStorage Class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Credential storage backed by an AuthCredentialStore.
 * Reads from storage on reload(), manages round-robin credential selection,
 * usage limit tracking, and OAuth token refresh.
 */
export class AuthStorage {
	static readonly #defaultBackoffMs = 60_000; // Default backoff when no reset time available

	/** Provider -> credentials cache, populated from store on reload(). */
	#data: Map<string, StoredCredential[]> = new Map();
	#runtimeOverrides: Map<string, string> = new Map();
	#configOverrides: Map<string, string> = new Map();
	/** Tracks next credential index per provider:type key for round-robin distribution (non-session use). */
	#providerRoundRobinIndex: Map<string, number> = new Map();
	/** Tracks the last used credential per provider for a session (used for rate-limit switching). */
	/** `operation:provider` keys already warned about, so the warning fires once. */
	#reportedStickyCacheFailures = new Set<string>();
	#sessionLastCredential: Map<string, Map<string, { type: AuthCredential["type"]; index: number }>> = new Map();
	/**
	 * Explicit per-session account choice, mirroring the pin cache rows so the hot
	 * resolve path costs a map lookup rather than a store read per request.
	 */
	#sessionPinnedCredential: Map<string, Map<string, number>> = new Map();
	/**
	 * Global per-provider account choice, memoised. `null` means "asked the store, it has none",
	 * which is what keeps a provider without a choice from re-querying on every credential resolve.
	 */
	#providerSelection: Map<string, string | null> = new Map();
	/** Recent bearer fingerprints resolved for each durable OAuth row; used only for delayed usage-limit attribution. */
	#oauthBearerFingerprints: Map<string, Map<number, string[]>> = new Map();
	/**
	 * Maps provider:type -> credentialIndex -> the temporary backoff entry.
	 *
	 * The write time rides along with the deadline so a backward clock jump can
	 * be detected on read; see {@link isRecordFromFutureClock}.
	 */
	#credentialBackoff: Map<string, Map<number, InMemoryCredentialBlock>> = new Map();
	/** Earliest time a freshly-set in-memory block may be cleared by live usage reconciliation. */
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
	/**
	 * Buffer for credential_disabled events fired while no listener is subscribed.
	 * Drained (in insertion order) to the first listener that triggers the empty→non-empty
	 * transition via {@link AuthStorage.onCredentialDisabled}. Bounded at
	 * {@link MAX_PENDING_DISABLED_EVENTS}; oldest entries are dropped to keep memory predictable
	 * if a long-lived AuthStorage somehow accumulates a backlog (provider count is naturally small,
	 * but a process that runs without subscribers for a long time shouldn't grow this unboundedly).
	 */
	#pendingDisabledEvents: CredentialDisabledEvent[] = [];
	/**
	 * Auth-death failover subscribers.
	 *
	 * Not buffered the way disable events are: a failover notice is about what is happening to
	 * the request in flight, so replaying one to a listener that subscribes minutes later would
	 * announce a move the operator has long since lived through.
	 */
	#credentialFailoverListeners: Set<(event: CredentialFailoverEvent) => void | Promise<void>> = new Set();
	/** Provider → the account auth death just retired, awaiting the resolve that names its replacement. */
	#pendingFailover: Map<string, { from: { credentialId: number; label: string }; cause: string; at: number }> =
		new Map();
	/**
	 * Withheld-quota subscribers, unbuffered for the same reason failover notices are: the news is
	 * about the turn that is waiting right now.
	 */
	#usageLimitWithheldListeners: Set<(event: UsageLimitWithheldEvent) => void | Promise<void>> = new Set();
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
			// Permanent for this AuthStorage's lifetime; the unsubscribe handle is discarded.
			this.onCredentialFailover(options.onCredentialFailover);
		}
		if (options.onUsageLimitWithheld) {
			// Permanent for this AuthStorage's lifetime, exactly like the failover subscription above.
			this.onUsageLimitWithheld(options.onUsageLimitWithheld);
		}
		this.#usageCache = new AuthStorageUsageCache(this.#store);
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
		this.#refreshOAuthCredentialOverride = options.refreshOAuthCredential;
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
		for (const listener of [...this.#generationListeners]) {
			try {
				listener(this.#generation);
			} catch (error) {
				logger.debug("AuthStorage generation listener failed", { reason, error: String(error) });
			}
		}
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

	/**
	 * Subscribe to auth-death failover notices. Returns an unsubscribe handle.
	 *
	 * Listener faults are isolated exactly as they are for disable events: a subscriber that
	 * throws must not break the rotation that is trying to keep the request alive.
	 */
	onCredentialFailover(listener: (event: CredentialFailoverEvent) => void | Promise<void>): () => void {
		this.#credentialFailoverListeners.add(listener);
		return () => {
			this.#credentialFailoverListeners.delete(listener);
		};
	}

	#emitCredentialFailover(event: CredentialFailoverEvent): void {
		for (const listener of [...this.#credentialFailoverListeners]) {
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

	/**
	 * Subscribe to withheld-quota notices (quota exhausted, siblings idle, balancing off).
	 * Returns an unsubscribe handle. Listener faults are isolated like every other notice here.
	 */
	onUsageLimitWithheld(listener: (event: UsageLimitWithheldEvent) => void | Promise<void>): () => void {
		this.#usageLimitWithheldListeners.add(listener);
		return () => {
			this.#usageLimitWithheldListeners.delete(listener);
		};
	}

	#emitUsageLimitWithheld(event: UsageLimitWithheldEvent): void {
		for (const listener of [...this.#usageLimitWithheldListeners]) {
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

	/** Returns all credentials for a provider as an array */
	#getCredentialsForProvider(provider: string): AuthCredential[] {
		return this.#getStoredCredentials(provider).map(entry => entry.credential);
	}

	/** Composite key for round-robin tracking: "anthropic:oauth" or "openai:api_key" */
	#getProviderTypeKey(provider: string, type: AuthCredential["type"]): string {
		return `${provider}:${type}`;
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
	 * FNV-1a hash for deterministic session-to-credential mapping.
	 * Ensures the same session always starts with the same credential.
	 */
	#getHashedIndex(sessionId: string, total: number): number {
		if (total <= 1) return 0;
		return Bun.hash.xxHash32(sessionId) % total;
	}

	/**
	 * Returns credential indices in priority order for selection.
	 * With sessionId: starts from hashed index (consistent per session).
	 * Without sessionId: starts from round-robin index (load balancing).
	 * Order wraps around so all credentials are tried if earlier ones are blocked.
	 */
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

	/** Returns in-memory block expiry timestamp for a credential/key pair, cleaning up expired entries. */
	#getCredentialBlockedUntilForKey(backoffKey: string, credentialIndex: number, nowMs: number): number | undefined {
		const backoffMap = this.#credentialBackoff.get(backoffKey);
		if (!backoffMap) return undefined;
		const entry = backoffMap.get(credentialIndex);
		if (!entry?.blockedUntilMs) return undefined;
		const { blockedUntilMs: blockedUntil, blockedAtMs } = entry;
		// A block written by a clock ahead of this one has a deadline measured in
		// units this clock no longer shares, so honouring it would block the
		// credential for the length of the jump. Drop it exactly like an expired
		// one; the provider re-blocks on the next real rate-limit response.
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

	/** Returns block expiry timestamp for a credential, checking unscoped and scoped blocks. */
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
		// The one place where the persisted read deliberately DIVERGES from the
		// in-memory read above, which honours an unscoped block under every scope.
		// The asymmetry is about where each copy can have come from, so it is not
		// the inconsistency it looks like:
		//
		//  - An in-memory unscoped block was written by THIS process, by one of the
		//    three credential-wide writers (a transient token-refresh failure, or a
		//    rotate-away after an upstream rejection). Those really are global — the
		//    credential itself is unusable — so every scope must see them.
		//  - A PERSISTED unscoped row for `openai-codex` may instead be LEGACY data:
		//    older versions recorded Codex rate-limit windows without a scope, so a
		//    row that reads as "globally blocked for a week" may really have been one
		//    quota window. Honouring it under a scope would strand an account that a
		//    scoped read can see is fine, for as long as the stale deadline runs.
		//
		// Hence: a scoped Codex read skips the persisted global row and trusts the
		// scoped one. Pinned by `auth-storage-global-block-scope-agreement.test.ts`
		// and by "ignores legacy global Codex blocks when a scoped quota window has
		// fresh siblings" in `auth-storage-codex-selection.test.ts`. Do not
		// "simplify" this to an unconditional read; that was tried and it broke the
		// legacy case.
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
		return this.#getCredentialBlockedUntil(provider, providerKey, credentialIndex, blockScope);
	}

	/** Checks if a credential is temporarily blocked due to usage limits. */
	#isCredentialBlocked(
		provider: string,
		providerKey: string,
		credentialIndex: number,
		blockScope: string | undefined = undefined,
	): boolean {
		return this.#getCredentialBlockedUntil(provider, providerKey, credentialIndex, blockScope) !== undefined;
	}

	/** Marks a credential as blocked until the specified time. */
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
		// A block already invalidated by a backward jump must not raise the new
		// deadline through MAX, or the jump would survive being re-blocked.
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
		if (!sessionId) return;
		const sessionMap = this.#sessionLastCredential.get(provider) ?? new Map();
		sessionMap.set(sessionId, { type, index });
		this.#sessionLastCredential.set(provider, sessionMap);

		try {
			if (credentialId !== undefined) {
				const cacheKey = `${SESSION_STICKY_CACHE_PREFIX}${provider}:${sessionId}`;
				const cacheValue = JSON.stringify({ type, index, credentialId });
				// Expires in 30 days
				const expiresAtSec = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
				this.#store.setCache(cacheKey, cacheValue, expiresAtSec);
			}
		} catch (err) {
			this.#reportStickyCacheFailure("write", provider, err);
		}
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
		this.#emitCredentialFailover({
			provider,
			from: pending.from,
			to: { credentialId: servedCredentialId, label: this.#accountNoticeLabel(provider, servedCredentialId) },
			cause: pending.cause,
		});
	}

	/**
	 * Report a session-stickiness cache failure LOUDLY, once per provider and
	 * operation, then let the request continue.
	 *
	 * All four of these paths used to be `logger.debug` and carry on, which is a
	 * silent fallback: the request still succeeds, so nothing looks wrong, but
	 * session stickiness has stopped working. Stickiness is what keeps one session
	 * pinned to one credential, so losing it means a conversation can hop between
	 * accounts mid-flight — the same wrong-account routing the index-only cache
	 * rows are explicitly dropped to prevent, arrived at by a different route. An
	 * operator debugging "why did this session switch accounts" would find nothing
	 * above debug level.
	 *
	 * Not fail-closed: a cache that cannot be written must not take down a request
	 * that is otherwise fine. Loud, bounded and recorded instead, which is the form
	 * of degrade this codebase does allow. Bounded matters here, because the usual
	 * cause is a store that is broken for the whole process (read-only file, disk
	 * full), and warning on every request would bury the line it is trying to make
	 * visible. The first failure per provider and operation warns; the rest are
	 * debug, so the signal survives without the flood.
	 */
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

	/**
	 * Resolve a pin to a live credential index, dropping a pin whose credential is gone.
	 *
	 * Stored by row id, resolved to an index on every read, exactly like the sticky
	 * record: an index alone is meaningless once the row set changes, and honouring a
	 * stale one routes the session to somebody else's account.
	 */
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
			// The pinned account was logged out or replaced. Forget the pin rather than
			// leave a dangling id that would be re-resolved on every request.
			this.clearSessionCredentialPin(provider, sessionId);
			return this.#getSelectedCredential(provider);
		}
		const credential = stored[index]?.credential;
		if (!credential) return this.#getSelectedCredential(provider);
		return { type: credential.type, index, credentialId };
	}

	/**
	 * The credential this session prefers: an explicit user pin when one resolves,
	 * otherwise the last credential routing actually used.
	 *
	 * The pin is checked FIRST and this is the only place that decides it, because every
	 * consumer of session preference goes through here (OAuth selection, account-identity
	 * display, rotation, usage attribution). Honouring the pin at one chokepoint is what
	 * makes `/account` switching real rather than cosmetic: a pin the resolver ignored
	 * would show the new account in the UI while requests kept using the old one.
	 */
	#getSessionCredential(
		provider: string,
		sessionId: string | undefined,
	): { type: AuthCredential["type"]; index: number } | undefined {
		// No early return on a missing session id: the GLOBAL selection is not session state, and a
		// caller with no session (a one-shot CLI, a subagent role resolving outside a session) must
		// still route to the account the user picked.
		const pinned = this.#getSessionCredentialPin(provider, sessionId);
		if (pinned) return { type: pinned.type, index: pinned.index };
		return this.#getStickySessionCredential(provider, sessionId);
	}

	/**
	 * The credential this session LAST ACTUALLY USED, ignoring any pin.
	 *
	 * Separate from {@link AuthStorage.#getSessionCredential} because two different questions
	 * are being asked and answering both with the pin makes one of them un-askable: "what
	 * should serve the next request" is the pin, but "what served the last one" is this, and
	 * `sessionCredentialRouting` needs the second to notice the two have diverged. Reading the
	 * pin for both is how a rate-limit rotation reports itself as the user's own choice.
	 */
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

	/** Clears the last credential used by a session for a provider. */
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

	/**
	 * Route this session's requests for one provider to one specific credential.
	 *
	 * PER PROVIDER, deliberately. Several providers serve one session at the same time
	 * (the main model, subagent roles, web search), so there is no single "current
	 * account" to switch: pinning Anthropic must leave the Codex and Gemini routing
	 * exactly as it was. Cross-provider movement is a MODEL choice, not an account one.
	 *
	 * Returns false when `credentialId` is not a live credential of `provider`, so a
	 * caller cannot record a pin that would silently resolve to nothing.
	 */
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
			// The in-memory pin still holds for this process, so the switch the user just
			// made does take effect; it simply will not survive a restart. Loud, because a
			// pin that quietly evaporates looks like the switch was ignored.
			this.#reportStickyCacheFailure("pin-write", provider, err);
		}
		// Drop the routing record so the next resolve re-ranks from the pin instead of
		// re-using whichever credential served the previous request.
		this.#clearSessionCredential(provider, sessionId);
		return true;
	}

	/** Forget an explicit account choice; routing returns to its own selection. */
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

	/**
	 * The account identity chosen for a provider, memoised per process.
	 *
	 * `null` in the memo means "the store was asked and has none", so a provider with no choice
	 * costs one query per process rather than one per credential resolve.
	 */
	#readProviderSelection(provider: string): string | undefined {
		const memo = this.#providerSelection.get(provider);
		if (memo !== undefined) return memo ?? undefined;
		const read = this.#store.getProviderSelection;
		const identity = read ? read.call(this.#store, provider) : undefined;
		this.#providerSelection.set(provider, identity ?? null);
		return identity;
	}

	/**
	 * The globally selected credential of a provider, resolved against the rows loaded now.
	 *
	 * Resolved on every read rather than cached as an index, for the same reason the pin is: an
	 * index is meaningless once the row set changes, and honouring a stale one routes to somebody
	 * else's account. A selection naming an account that is no longer stored resolves to nothing
	 * and is deliberately LEFT in the store — a re-login rewrites the row under the same identity,
	 * and forgetting the choice in between would silently move the user to a different account.
	 */
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

	/** The credential id the user chose for a provider, or undefined when they never chose. */
	selectedProviderCredentialId(provider: string): number | undefined {
		return this.#getSelectedCredential(provider)?.credentialId;
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
		const pinned = this.#getSessionCredentialPin(provider, sessionId);
		const chosen = pinned ?? this.#getSelectedCredential(provider);
		if (chosen?.type !== type) return undefined;
		const credentialId = this.#getStoredCredentials(provider)[chosen.index]?.id;
		if (credentialId !== undefined && this.#authDeadCredentials.has(credentialId)) return undefined;
		return chosen.index;
	}

	/**
	 * Choose the account a provider uses, for every session and every profile on this machine.
	 *
	 * GLOBAL, not session-scoped, because the credentials are: they live in one shared database
	 * that every profile reads, so a choice recorded per session evaporates on the next `veyyon`
	 * and a choice recorded per profile would disagree with the account list it was made from.
	 *
	 * PER PROVIDER, deliberately. Several providers serve one session at the same time (the main
	 * model, subagent roles, web search), so there is no single "current account" to switch:
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
		const entry = this.#getStoredCredentials(provider).find(row => row.id === credentialId);
		if (!entry) return false;
		const identity = resolveAccountNameIdentity(provider, entry);
		this.#providerSelection.set(provider, identity);
		const write = this.#store.setProviderSelection;
		if (write) {
			try {
				write.call(this.#store, provider, identity);
			} catch (err) {
				// The in-process choice still holds, so the switch the user just made does take
				// effect; it simply will not survive a restart. Loud, because a choice that quietly
				// evaporates looks like the switch was ignored.
				this.#reportStickyCacheFailure("selection-write", provider, err);
			}
		}
		// A session pin would outrank the global choice at the chokepoint, so the switch the user
		// just made must retire it rather than sit behind it.
		this.clearSessionCredentialPin(provider, options?.sessionId);
		this.#clearSessionCredential(provider, options?.sessionId);
		return true;
	}

	/** Forget the global choice for a provider; routing returns to its own selection. */
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
		const pin = this.#getSessionCredentialPin(provider, sessionId);
		// The LAST-USED record, never `#getSessionCredential`: that one answers with the pin,
		// so asking it here made `activeCredentialId` a copy of `selectedCredentialId` and the
		// divergence this method exists to report could never be observed.
		const sticky = this.#getStickySessionCredential(provider, sessionId);
		const stickyEntry = sticky ? stored[sticky.index] : undefined;
		if (pin) {
			routing.selectedCredentialId = pin.credentialId;
			// `${provider}:${type}`, the same composite `#getProviderTypeKey` builds. Passing the
			// bare credential type looked plausible and silently matched no block row at all, so
			// a blocked pin reported itself as healthy.
			const blockedUntil = this.credentialBlockedUntil(
				provider,
				this.#getProviderTypeKey(provider, stored[pin.index]!.credential.type),
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
		// The cascade recognised no credential type here, which leaves the last-used one as the only
		// account with any claim on the next request, blocked or not.
		if (stickyEntry) routing.activeCredentialId = stickyEntry.id;
		return routing;
	}

	/** Whether one stored credential is free of a live rate-limit block right now. */
	#credentialUsableNow(provider: string, entry: StoredCredential, index: number): boolean {
		const providerKey = this.#getProviderTypeKey(provider, entry.credential.type);
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
			// No choice promotion here, and none is missing: `sessionCredentialRouting` answers with the
			// explicit choice (pin, else provider selection) and returns before it ever asks for a
			// prediction, so every path that reaches this line has no live choice to promote.
			const ordered = this.#orderByBlockAvailability(provider, providerKey, rotated);
			const chosen = ordered[0];
			if (chosen) return chosen.entry.id;
		}
		return undefined;
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
	 * `#leadWithChosenAccount` on the prediction and by-type paths, the lead insert in
	 * `#resolveOAuthSelection` (which also weighs a session preference and a plan requirement), and
	 * `#selectApiKeyCredential`, which returns the chosen entry outright. A second exemption inside
	 * the sort was one more owner of that rule which no behaviour could distinguish from its absence.
	 */
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
				// `0` sorts every usable account ahead of every blocked one, and a real expiry is a
				// future epoch, so the two ranges cannot collide.
				blockedUntil: this.#getCredentialBlockedUntil(provider, providerKey, candidate.index, blockScope) ?? 0,
			}))
			.sort((left, right) =>
				left.blockedUntil === right.blockedUntil
					? left.position - right.position
					: left.blockedUntil - right.blockedUntil,
			)
			.map(entry => entry.candidate);
	}

	/**
	 * Put the explicitly chosen account at the head of an ordered candidate list.
	 *
	 * A choice outranks availability: a hold is this library's own prediction of when a provider
	 * will serve again, and it is not a reason to spend money on an account nobody asked for. So the
	 * move is unconditional, unlike the session-preference case in `#resolveOAuthSelection`, which
	 * leads only while it is usable.
	 */
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
		// An explicitly chosen account is not a candidate in a headroom contest, it is the answer.
		// Ranking exists to choose among accounts nobody named, so it never runs over a live choice —
		// with account movement on as much as off, since the setting governs the product's own
		// initiative and not what a caller may ask for.
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
		this.#sessionLastCredential.delete(provider);
		this.#clearProviderSessionCredentialCache(provider);
		for (const key of this.#credentialBackoff.keys()) {
			if (key.startsWith(`${provider}:`)) {
				this.#credentialBackoff.delete(key);
			}
		}
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
		this.#emitCredentialDisabled({ provider, disabledCause });
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

	#emitCredentialDisabled(event: CredentialDisabledEvent): void {
		if (this.#credentialDisabledListeners.size === 0) {
			// No subscribers — buffer for later replay. Cap the backlog so a process that runs
			// without subscribers for a long time can't grow memory unboundedly; drop oldest
			// under pressure.
			if (this.#pendingDisabledEvents.length >= MAX_PENDING_DISABLED_EVENTS) {
				this.#pendingDisabledEvents.shift();
			}
			this.#pendingDisabledEvents.push(event);
			return;
		}
		// Snapshot before iteration so a listener that subscribes/unsubscribes during fan-out
		// can't observe a partially-mutated set or receive an event it just registered for.
		const listeners = [...this.#credentialDisabledListeners];
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
		const sessionPref = this.#getSessionCredential(provider, sessionId);
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
		if (typeof result === "string") {
			// Some flows (e.g. ollama) return "" to signal that no key was entered.
			if (!result) {
				return undefined;
			}
			const newCredential: ApiKeyCredential = { type: "api_key", key: result, source: "login" };
			const stored = this.#store.upsertAuthCredentialRemote
				? await this.#store.upsertAuthCredentialRemote(provider, newCredential)
				: this.#store.upsertAuthCredentialForProvider(provider, newCredential);
			this.#setStoredCredentials(
				provider,
				stored.map(entry => ({ id: entry.id, credential: entry.credential })),
			);
			this.#resetProviderAssignments(provider);
			const credentialId = matchStoredCredentialId(stored, newCredential);
			return { type: "api_key", ...(credentialId !== undefined ? { credentialId } : {}) };
		}
		const newCredential: OAuthCredential = { type: "oauth", ...result };
		// Use #upsertOAuthCredential to upsert the new credential.
		// Any legacy api_key rows from older versions will be cleaned up so they do not
		// shadow the new OAuth row, while preserving other active OAuth credentials.
		const credentialId = await this.#upsertOAuthCredential(def.storeCredentialsAs ?? provider, newCredential);
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

	/**
	 * Translate a refreshed {@link UsageCredential} into the public
	 * {@link CompletionProbeCredential} shape. Returns `null` when the
	 * credential lacks any usable bearer bytes (e.g. an API-key row with an
	 * empty key, or an OAuth row that never had an `access` token written).
	 */
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

	/**
	 * Find the stored credential id matching a {@link UsageCredential} so the
	 * refresh override can address the row. Mirrors the matching logic in
	 * {@link AuthStorage.#persistRefreshedUsageCredential}.
	 */
	#findStoredCredentialIdForUsageCredential(provider: Provider, previous: UsageCredential): number | undefined {
		const entries = this.#getStoredCredentials(provider);
		// Broker-backed rows all carry REMOTE_REFRESH_SENTINEL as their refresh
		// token — it identifies nothing, and comparing it would match the FIRST
		// OAuth row regardless of which account/org is being refreshed.
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
		// Same sentinel rule as #findStoredCredentialIdForUsageCredential above.
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
		const cacheKey = this.#buildUsageReportCacheKey(request);
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
		// Throttled to one ingest per interval — except when a window reads
		// exhausted: that snapshot must land immediately so the next getApiKey
		// blocks the credential instead of burning a wire 429 on the wall.
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
		if (ids.size === 1) return [...ids][0];
		return undefined;
	}

	#getUsageReportScopeProjectId(report: UsageReport): string | undefined {
		const ids = new Set<string>();
		for (const limit of report.limits) {
			const projectId = limit.scope.projectId?.trim();
			if (projectId) ids.add(projectId);
		}
		if (ids.size === 1) return [...ids][0];
		return undefined;
	}

	#getUsageReportIdentifiers(report: UsageReport): string[] {
		const identifiers: string[] = [];
		const email = this.#getUsageReportMetadataValue(report, "email");
		if (email) identifiers.push(`email:${email.toLowerCase()}`);
		if (report.provider === "anthropic") {
			// Anthropic: one account email can hold several organizations
			// (Team seat + personal Max). Reports from different orgs must not
			// merge — scope every identifier by org when the report carries one.
			// When the email could not be recovered, fall back to the account
			// (identical across orgs, hence the org qualifier is what keeps two
			// subscriptions apart) so no-email reports still merge per org.
			// Org-less reports (pre-upgrade caches) keep their bare identifiers
			// and only merge among themselves.
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
		// Only add project as a fallback when no email is available — two users
		// with different emails on the same GCP project must not merge.
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
		const sorted = [...reports].sort((a, b) => {
			const limitDiff = b.limits.length - a.limits.length;
			if (limitDiff !== 0) return limitDiff;
			return (b.fetchedAt ?? 0) - (a.fetchedAt ?? 0);
		});
		const base = sorted[0];
		const mergedLimits = [...base.limits];
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

	/** Return the usage limits that apply to the requested model for this strategy. */
	#getScopedUsageLimits(
		strategy: CredentialRankingStrategy,
		report: UsageReport,
		context: CredentialRankingContext,
	): UsageLimit[] {
		return strategy.scopeLimits?.(report, context) ?? report.limits;
	}

	/** Returns true if usage indicates rate limit has been reached. */
	#isUsageLimitReached(limits: UsageLimit[]): boolean {
		return limits.some(limit => this.#isUsageLimitExhausted(limit));
	}

	/** Extracts the earliest reset timestamp from exhausted windows (in ms). */
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
			const reports = await raceUsageWithSignal(shared, options?.signal);
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
			// no outer cache write — see comment above.
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
					? this.#buildUsageRequest(row.provider as Provider, { type: "api_key", apiKey: cred.key }, baseUrl)
					: this.#buildUsageRequestForOauth(row.provider as Provider, cred, baseUrl);

			// Scoped per-row deadline: cancelled at both loop exits below so the
			// backing timer never outlives the row's probes (a bare
			// AbortSignal.timeout stays armed for the full timeout). Every await
			// in between is individually try/caught, so the exits are exhaustive.
			const probeTimeout = scopedTimeoutSignal(timeoutMs, options?.signal);
			const probeSignal = probeTimeout.signal;
			let params: UsageFetchParams & { signal: AbortSignal } = {
				...initialRequest,
				accountKey: this.#buildUsageCacheIdentity(initialRequest.credential),
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

		// Usage lookup may refresh, disable, or remove a row. Re-resolve its
		// durable id before applying positional in-memory and persisted blocks.
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

	/**
	 * Computes the required drain rate: `headroomFraction / remainingHours` —
	 * how fast the window's remaining quota must be consumed to fully use it
	 * before it resets and expires. Higher = more headroom at risk of expiring
	 * unused = ranked first, so selection chases quota that is about to be
	 * wasted ("use it or lose it"). Without a reset clock the headroom
	 * fraction alone is returned, degrading to most-headroom-first.
	 */
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
		// Floor at one minute: a stale report whose reset already passed must
		// not produce an unbounded urgency score.
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
		// Short-window guard: candidates whose primary (e.g. 5h) window is
		// nearly exhausted rank behind cool ones regardless of drain urgency —
		// overflow lands on the next-most-urgent cool account instead.
		const leftHot = left.primaryUsed >= PRIMARY_WINDOW_HOT_FRACTION;
		const rightHot = right.primaryUsed >= PRIMARY_WINDOW_HOT_FRACTION;
		if (leftHot !== rightHot) return leftHot ? 1 : -1;
		// Usage-backed candidates outrank unmeasured ones: required-drain
		// scores are only comparable between measured windows, and the
		// clockless headroom fallback (0..1) must not let an account whose
		// usage fetch failed shadow a measured sibling.
		const leftMeasured = left.usage !== null;
		const rightMeasured = right.usage !== null;
		if (leftMeasured !== rightMeasured) return leftMeasured ? -1 : 1;
		// Required drain, descending: the account whose remaining quota must
		// burn fastest to avoid expiring unused at its reset comes first, so
		// staggered resets land at ~100% utilization instead of stranding
		// headroom that a cooler sibling could have absorbed.
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
		// Pre-fetch usage reports in parallel for non-blocked credentials.
		// Wrap with a timeout so slow/429'd fetches don't indefinitely block
		// credential selection — better to pick a credential without usage data
		// than to hang the agent waiting for rate-limited usage endpoints.
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
		// Skip ranking only when the session already has a working preferred credential — re-ranking
		// mid-session causes account switches that cold-start the server-side prompt cache. New sessions
		// (no preference) and sessions whose preferred is blocked still rank, so we pick the account
		// with the most headroom proactively and fall back intelligently when rate-limited.
		const sessionPreferredIsAvailable =
			sessionPreferredIndex !== undefined &&
			sessionPreferredCanRefreshOrUse &&
			!this.#isCredentialBlocked(provider, providerKey, sessionPreferredIndex, blockScope);
		// The explicitly chosen account, which outranks every automatic decision below:
		// ranking may reorder around it, a hold may not displace it, and the strict pass may not skip
		// it. `sessionPreferredIndex` is not the same thing — it also carries sticky routing, which is
		// a record of what served last rather than anything anybody asked for.
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

		// The chosen account leads, hold or no hold. A plan requirement is the one thing that can
		// still displace it: an account without the entitlement cannot serve the model at all, so
		// leading with it would fail the request rather than honour anything.
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

		// Enforce a tier only when at least one account is confirmed eligible. If
		// every report is unknown or ineligible, preserve trial/grandfathered access
		// by allowing the normal candidate fallback to attempt the request.
		const enforcePlanRequirement =
			hasPlanRequirement &&
			candidates.some(candidate => getOpenAICodexPlanEligibility(candidate.usage, planRequirement) === true);

		// The strict pass tries a usable account before an exhausted one, which is what makes quota
		// fallback work. An explicitly chosen account is exempt from it: a hold is our own prediction,
		// and skipping the chosen account over a prediction is what left a redeemed limit reset
		// unable to spend the very account it belonged to. Every other account still waits for
		// the blocked-allowing pass, and a dead grant still falls through to a sibling from either
		// pass, because auth death is the provider's verdict rather than ours.
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

	/** Whether the store exposes the full durable-lease surface both fenced paths need. */
	#storeSupportsDurableLease(): boolean {
		return (
			!!this.#store.tryAcquireCredentialRefreshLease &&
			!!this.#store.getCredentialRefreshLeaseExpiresAt &&
			!!this.#store.releaseCredentialRefreshLease &&
			!!this.#store.renewCredentialRefreshLease
		);
	}

	/**
	 * Run `fn` while holding a refresh lease, renewing it in the background so a
	 * refresh slower than the lease TTL does not lose ownership mid-flight.
	 *
	 * The ownership loss is REPORTED alongside the result, never thrown. By the time
	 * it is known the provider has usually already spent the single-use refresh token,
	 * and throwing would discard a rotation that can never be obtained again, which is
	 * the "logged out after a rebuild" failure the lease exists to prevent. Each caller
	 * decides what a lost lease means for its own persist.
	 *
	 * `credentialId === undefined` means the refresh is not lease-fenced at all (the
	 * store lacks the durable-lease surface, or the row was never leased), so no
	 * renewal loop runs and `ownershipLost` is always undefined.
	 *
	 * This is the one renewal loop. Both fenced refresh paths, `#leaseFencedRefresh`
	 * for model providers and `refreshStoredOAuthCredential` for MCP, go through it.
	 */
	async #withRefreshLeaseRenewal<T>(
		credentialId: number | undefined,
		owner: string,
		fn: () => Promise<T>,
	): Promise<{ result: T; ownershipLost: unknown }> {
		if (credentialId === undefined) return { result: await fn(), ownershipLost: undefined };
		let stop = false;
		let ownershipLost: unknown;
		// The renewal loop must wake IMMEDIATELY when the refresh finishes, not at the
		// end of its current sleep. Waiting out a full renew interval would delay the
		// rotation's persistence by seconds — long enough for a caller that already
		// aborted to be gone, and long enough to be a latency bug on every refresh even
		// when nothing goes wrong.
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

		// The teardown runs in `finally` so it happens on every path, but nothing is
		// raised from inside it: a `throw` in `finally` replaces whatever the block was
		// already doing, so when `fn` itself fails it would discard that error and
		// report a generic ownership one in its place, hiding the actual cause.
		let result: T;
		try {
			result = await fn();
		} catch (error) {
			stop = true;
			stopped.resolve();
			await renewal;
			if (ownershipLost !== undefined) {
				// `fn`'s error is the one that explains the failure and the one the caller
				// gets. This one is real too and only one can be thrown, so surface it
				// rather than dropping it (Law 10).
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

	/**
	 * The credential a PEER already rotated, if one exists and is usable.
	 *
	 * Reads by id including disabled rows, because the peer's winning row may be the
	 * one a loser disabled. Returns it only when the row still belongs to the provider
	 * we are refreshing, the refresh token actually differs from what we hold (proof of
	 * a rotation, not a re-read of our own row), and it is not about to expire, so we
	 * never hand back a token that would immediately need refreshing again.
	 *
	 * The provider check is what makes reading by a bare id safe. Nothing in the
	 * lookup constrains WHICH provider the returned row belongs to: `readAuthCredentialById`
	 * is an optional method on the `AuthCredentialStore` interface, so the row comes
	 * from whatever store is plugged in, and the ids in the shipped SQLite store are
	 * not the only ones that can appear there — the explicit-id INSERT paths used by
	 * migration and import write ids chosen elsewhere. A row for another provider is
	 * a live, unexpired OAuth credential whose refresh token differs from ours, which
	 * is exactly the signature this function reads as "a peer rotated it", so without
	 * the check that provider's token would be returned here and sent upstream as
	 * ours. Refuse, loudly (Law 10), instead of falling through to a credential that
	 * merely has the right shape.
	 *
	 * (The shipped `SqliteAuthCredentialStore` declares `id INTEGER PRIMARY KEY
	 * AUTOINCREMENT`, so it will not hand a freed id back on its own. This is a
	 * boundary check on the interface, not a fix for a race in that one store.)
	 */
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
			// Names only: the row is somebody else's credential, and nothing about its
			// contents belongs in a log.
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

	/**
	 * Merge a rotated credential onto the row and persist it, independently of
	 * whatever the caller is doing.
	 *
	 * This exists because the caller's `await` can be abandoned — a shutdown, a
	 * rebuild, or an ESC aborts the caller while the refresh itself keeps going and
	 * resolves a moment later with a rotated, single-use token. If only the caller
	 * persisted, that token would be lost while the provider had already invalidated
	 * the old one, and the NEXT run would refresh with a dead token, be told
	 * `invalid_grant`, and permanently disable a perfectly good login. Committing
	 * here, inside the single-flight, makes the rotation durable no matter who is
	 * still listening.
	 */
	#commitRotatedOAuthCredential(
		provider: Provider,
		credentialId: number,
		previous: OAuthCredential,
		refreshed: OAuthCredentials,
	): void {
		// Never clobber a peer that rotated FORWARD while we were in flight. Our write
		// can land arbitrarily late (the caller may have aborted seconds ago), and the
		// stored row may by then hold a strictly newer single-use token. Overwriting it
		// with ours would spend the peer's rotation for nothing and put a dead token on
		// disk, which is the very failure this path exists to prevent.
		const peerFresh = this.#freshRotatedCredential(provider, credentialId, previous);
		if (peerFresh && peerFresh.refresh !== refreshed.refresh) return;

		const merged: OAuthCredential = { ...previous, ...refreshed, type: "oauth" };
		this.#persistRefreshedCredentialById(provider, credentialId, merged);
	}

	/**
	 * Refresh under a CROSS-PROCESS lease, so a single-use refresh token is spent
	 * exactly once even when several veyyon processes share one credential store.
	 *
	 * The in-process single-flight cannot help here: the racing refreshes live in
	 * different processes. Whoever takes the lease refreshes; everyone else waits and
	 * then reads the peer's rotated token instead of burning their own now-dead one.
	 * That converts the rotation race from something to be healed after the fact into
	 * something that cannot happen.
	 *
	 * Note carefully what `signal` gates: ONLY the wait for ownership. Once the
	 * refresh is under way it must run to completion and persist, because aborting
	 * after the provider has rotated the token would strand it — the same loss this
	 * whole path exists to prevent.
	 */
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
			// Re-check under the lease: a peer may have rotated between our last check
			// and acquiring ownership.
			const peerFresh = this.#freshRotatedCredential(provider, credentialId, credential);
			if (peerFresh) return peerFresh;

			const { result: refreshed, ownershipLost } = await this.#withRefreshLeaseRenewal(credentialId, owner, () =>
				this.#refreshOAuthCredentialUnshared(provider, credential, credentialId),
			);

			if (ownershipLost !== undefined) {
				// The token is already rotated and the old one is dead at the provider, so
				// discarding it here would guarantee the logout. Commit on the data CAS
				// alone, then prefer whatever the store ended up holding.
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
				// Commit as a SAFETY NET for the one case the caller cannot cover: its own
				// abort. Normally the caller that awaited this refresh persists the
				// credential itself, and it often knows more than we do here (the usage path
				// adds the provider's resolved `apiEndpoint`), so writing again would be
				// both redundant and less complete.
				//
				// When the caller aborted, though, nobody persists. The refresh still
				// completed and the provider has already invalidated the old token, so
				// leaving it on disk is exactly the "logged out after a rebuild" failure:
				// the next run refreshes with a dead token, gets `invalid_grant`, and
				// disables a perfectly good login. So commit precisely then.
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
		// Caller override > store-level hook > local per-provider refresh.
		// `RemoteAuthCredentialStore` exposes the hook so a broker-backed gateway
		// routes refresh through the broker without explicit wiring.
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
		// Bound the refresh so a slow/hanging token endpoint cannot stall credential selection.
		// Caller-driven abort jumps the gun on the timeout — the agent's ESC must
		// take priority over the floor timeout.
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
		if (!allowBlocked && this.#isCredentialBlocked(provider, providerKey, selection.index, blockScope)) {
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
			// The preflight already refreshed this credential in this same call and
			// the provider rejected the grant definitively. The token is single-use
			// and now dead, so asking again is a guaranteed second 400: reuse the
			// verdict and drop into the handling below, which is where disabling
			// (and the peer-rotation re-read that can still rescue the row) lives.
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
				// Refresh first through the broker-aware single-flighted machinery
				// so transient failures surface as network errors (5-min temp block)
				// instead of `getOAuthApiKey`'s "expired" precondition error, which
				// the definitive-failure regex below would otherwise classify as
				// auth failure and soft-disable a still-valid credential.
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
				this.#markCredentialBlocked(provider, providerKey, selection.index, Date.now() + 5 * 60 * 1000);
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
		const providerKey = this.#getProviderTypeKey(provider, "oauth");
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
		const providerKey = this.#getProviderTypeKey(provider, "oauth");
		return this.#resolveStoredOAuthAccess(provider, selection, providerKey, options);
	}

	/**
	 * List saved rate-limit resets for every stored OAuth account of `provider`
	 * (Codex), fetched LIVE from the dedicated `rate-limit-reset-credits` route.
	 *
	 * This deliberately bypasses the usage-report cache: `/wham/usage` is
	 * IP-rate-limited and may serve stale (or pre-feature) snapshots when many
	 * accounts are polled, which would hide redeemable credits. One entry per
	 * account, with the session's active account flagged and unreachable
	 * accounts carrying an `error`.
	 */
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

	/**
	 * Redeem one saved rate-limit reset (OpenAI Codex "saved resets") for a
	 * specific stored account.
	 *
	 * Resolves a fresh access token for the target account, picks an available
	 * credit (the given `creditId`, else the first redeemable one), spends it,
	 * and invalidates the cached usage report so the next `/usage` reflects the
	 * reset. Never throws for business outcomes — inspect the returned `code`.
	 */
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
			// The window this credential was blocked on (by markUsageLimitReached)
			// is now reset, so lift its temporary block — otherwise selection
			// keeps skipping/under-ranking the freshly-reset account.
			if (match.credentialId !== undefined) this.clearCredentialBlocks(provider, match.credentialId);
		}
		return { ok: result.ok, code: result.code, accountId: match.accountId, email: match.email, creditId };
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
			const cacheKey = this.#buildUsageReportCacheKey(
				this.#buildUsageRequestForOauth(provider, entry.credential, baseUrl),
			);
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

	/**
	 * Self-heal a stale Codex usage-limit block: when a fresh live usage report
	 * says the account is allowed and below every reported limit, drop the
	 * persisted and in-memory `openai-codex:oauth` blocks so credential selection
	 * can re-include recovered seats before a stale block naturally expires.
	 */
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
		// Mirror selection: consult the same strategy scope `markUsageLimitReached`
		// persists under, else a scoped block is invisible here and never healed.
		const blockScope = this.#rankingStrategyResolver?.(provider)?.blockScope?.({});
		const blockedUntilMs = this.#getCredentialBlockedUntil(provider, providerKey, credentialIndex, blockScope);
		if (blockedUntilMs === undefined) return;
		// `/usage` can lag the request path that just returned 429. Fresh local or
		// broker-sourced blocks get one usage-cache window before healthy reports may
		// clear them.
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
			// This asks whether an API key is a structured envelope carrying a token. Text that only LOOKS like
			// JSON is not one, so undefined means "use the key as-is", exactly as for a plain key.
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
		const status = AIError.status(error);
		const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
		if (AIError.isUsageLimit(error) || isUsageLimitOutcome(status, message)) {
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
		// Snapshot sibling availability before mutating so a soft-deleting
		// suspect hook can't reindex the answer out from under us.
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
		// Everything from here down is the NON-quota path: the usage-limit case returned above. So the
		// account failed authentication, and an explicit choice must stop pinning traffic to it —
		// otherwise a revoked grant would be retried until the turn died instead of failing over.
		if (target) this.#authDeadCredentials.add(target.id);
		this.#markCredentialBlocked(
			provider,
			providerKey,
			sessionCredential.index,
			Date.now() + AuthStorage.#defaultBackoffMs,
		);

		if (hasSibling && target) {
			// Parked, not emitted: the label of the account that DIED must be read now, before
			// `markCredentialSuspect` soft-deletes the row and the name it was known by with it.
			// The replacement is named later, by the resolve that actually serves.
			this.#pendingFailover.set(provider, {
				from: { credentialId: target.id, label: this.#accountNoticeLabel(provider, target.id) },
				cause: message ?? (status !== undefined ? `HTTP ${status}` : "authentication failed"),
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
					const status = AIError.status(error);
					const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
					// Preserve no-sibling quota backoff instead of re-resolving an
					// already-blocked fallback. Hard-auth declines still re-resolve
					// because a peer may have refreshed the failed bearer.
					if (AIError.isUsageLimit(error) || isUsageLimitOutcome(status, message)) return undefined;
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
		return { generation: this.#generation, generatedAt: Date.now(), credentials: entries };
	}

	/**
	 * Refresh the OAuth credential with the given id through a per-credential
	 * single-flight. Concurrent callers for the same row await the same upstream
	 * refresh attempt, which is required for providers that rotate refresh tokens
	 * on every successful refresh.
	 */
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
				refreshed = await this.#refreshOAuthCredential(provider as Provider, stale, id, signal);
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
			this.#emitCredentialDisabled({ provider, disabledCause });
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
		this.#bumpGeneration("credential-block");
	}

	/**
	 * Broker-server seam: clear all persisted blocks for one credential and notify snapshot waiters.
	 */
	deleteCredentialBlocks(credentialId: number): void {
		const deleteCredentialBlocks = this.#store.deleteCredentialBlocks?.bind(this.#store);
		if (!deleteCredentialBlocks) return;
		deleteCredentialBlocks(credentialId);
		this.#bumpGeneration("credential-block");
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
