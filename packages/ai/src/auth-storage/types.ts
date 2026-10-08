/**
 * The credential vocabulary shared by `AuthStorage`, its stores and its callers: credential shapes,
 * the store interface, snapshot shapes for the auth broker, health-check results, event payloads,
 * options, and the saved-reset shapes.
 */

import type { OAuthCredentials } from "../registry/oauth/types";
import type { Provider } from "../types";
import type {
	CredentialRankingStrategy,
	UsageCostHistoryEntry,
	UsageCostHistoryQuery,
	UsageHistoryEntry,
	UsageHistoryQuery,
	UsageLogger,
	UsageProvider,
	UsageReport,
	UsageResetCreditDetail,
} from "../usage";

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
 * Serialized representation of AuthStorage for passing to agent workers.
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
	 * Whether the product may move a provider between the operator's accounts on its own
	 * initiative: quota and rate-limit exhaustion, usage-headroom ranking, and the per-session /
	 * round-robin spread of new sessions across accounts.
	 *
	 * Defaults to `false`. The coding-agent passes the operator's `accounts.loadBalancing`
	 * setting, which also defaults to OFF: spreading one operator's work across their accounts
	 * is a choice with consequences they must opt into, not a default. Off means exactly one
	 * account per provider and credential type serves — the explicit choice, else the account the
	 * session last used, else the first in storage order — and it keeps serving while blocked.
	 *
	 * This gates ONLY the product's own movement. Auth death is never gated: a revoked
	 * credential cannot serve the request at all, so refusing to move would just fail. A plan
	 * requirement an account cannot meet is treated the same way. An explicit choice (a session
	 * pin or the provider selection) is never gated either; it is what the caller asked for.
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

/** Providers whose OAuth accounts carry saved usage resets that veyyon can list and redeem. */
export const RESET_CREDIT_PROVIDERS = ["openai-codex", "anthropic"] as const;
export type ResetCreditProvider = (typeof RESET_CREDIT_PROVIDERS)[number];

/**
 * Identifies which stored account to redeem a saved rate-limit reset for.
 * Any one of the account fields is enough; `credentialId` is the most precise.
 */
export interface ResetCreditTarget {
	provider: ResetCreditProvider;
	credentialId?: number;
	accountId?: string;
	email?: string;
}

/**
 * Result code of {@link AuthStorage.redeemResetCredit}, in one vocabulary for every provider.
 * `reset` is success. Business outcomes that spent nothing: `already_redeemed`, `no_credit`,
 * `nothing_to_reset`, `cooldown` (Anthropic: the server rejects claims until a set time),
 * `ineligible`, `unavailable`. Local: `no_account` (target not found), `account_unavailable`
 * (token refresh failed), `no_organization` (Anthropic account without an organization id),
 * `status_unavailable` (the reset status could not be read). Transport: `rate_limited`,
 * `auth_error`, `http_<status>`.
 */
export type ResetCreditRedeemCode =
	| "reset"
	| "already_redeemed"
	| "no_credit"
	| "nothing_to_reset"
	| "cooldown"
	| "ineligible"
	| "unavailable"
	| "no_account"
	| "account_unavailable"
	| "no_organization"
	| "status_unavailable"
	| "rate_limited"
	| "auth_error"
	// Forward-compatible: unknown future backend codes pass through.
	| (string & {});

/** Outcome of {@link AuthStorage.redeemResetCredit}. */
export interface ResetCreditRedeemOutcome {
	/** `true` only when a reset was actually applied (`code === "reset"`). */
	ok: boolean;
	code: ResetCreditRedeemCode;
	provider: ResetCreditProvider;
	accountId?: string;
	email?: string;
	/** The credit or grant that was spent, or would have been. */
	creditId?: string;
}

/** One stored account's live saved-reset status, from {@link AuthStorage.listResetCredits}. */
export interface ResetCreditAccountStatus {
	provider: ResetCreditProvider;
	credentialId?: number;
	accountId?: string;
	email?: string;
	/** Resets redeemable for this account right now (live, not cached). */
	availableCount: number;
	credits: UsageResetCreditDetail[];
	/** Whether this is the given session's active account for its provider. */
	active: boolean;
	/** Set when the account's token refresh or list call failed. */
	error?: string;
}
