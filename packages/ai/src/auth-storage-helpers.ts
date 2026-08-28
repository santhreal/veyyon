import { createHash } from "node:crypto";
import * as AIError from "./error";
import type { OAuthCredentials } from "./registry/oauth/types";
import type { Provider } from "./types";
import type {
	CredentialRankingStrategy,
	UsageCostHistoryEntry,
	UsageCostHistoryQuery,
	UsageCredential,
	UsageHistoryEntry,
	UsageHistoryQuery,
	UsageLogger,
	UsageProvider,
	UsageReport,
} from "./usage";
import type { CodexResetConsumeCode, CodexResetCredit } from "./usage/openai-codex-reset";
import { resolveRegisteredRankingStrategy, resolveRegisteredUsageProvider } from "./usage/registry";

export const AUTH_HTTP_CONCURRENCY_LIMIT = 8;

export type PendingAuthHttpOperation = () => void;

export class AuthHttpConcurrencyPolicy {
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

export const authHttpConcurrencyPolicy = new AuthHttpConcurrencyPolicy();

export function withAuthHttpConcurrency<T>(operation: () => Promise<T>): Promise<T> {
	return authHttpConcurrencyPolicy.run(operation);
}

export const USAGE_RANKING_METRIC_EPSILON = 1e-9;
export const PRIMARY_WINDOW_HOT_FRACTION = 0.85;
export const OAUTH_BEARER_FINGERPRINT_HISTORY_LIMIT = 8;

export function fingerprintOAuthBearer(bearer: string): string {
	return createHash("sha256").update(bearer).digest("base64url");
}
export const SESSION_STICKY_CACHE_PREFIX = "session:sticky:";
export const SESSION_PIN_CACHE_PREFIX = "session:pin:";

export const SESSION_PIN_TTL_SECONDS = 30 * 24 * 60 * 60;

export const FAILOVER_NOTICE_WINDOW_MS = 60_000;

export interface SessionCredentialRouting {
	provider: string;
	selectedCredentialId?: number;
	activeCredentialId?: number;
	activeIsPrediction?: boolean;
	selectedBlockedUntilMs?: number;
}

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

export type CredentialOriginKind = "runtime" | "config" | "oauth" | "api_key" | "env" | "fallback";

export interface CredentialOrigin {
	kind: CredentialOriginKind;
	envVar?: string;
}

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

export interface StoredAuthCredential {
	id: number;
	provider: string;
	credential: AuthCredential;
	disabledCause: string | null;
}

export interface InMemoryCredentialBlock {
	blockedUntilMs: number;
	blockedAtMs: number;
}

export interface StoredCredentialBlock {
	credentialId: number;
	providerKey: string;
	blockScope: string;
	blockedUntilMs: number;
	updatedAtMs?: number;
}

export interface CredentialHealthResult {
	id: number;
	provider: string;
	type: AuthCredential["type"];
	email?: string;
	accountId?: string;
	orgId?: string;
	orgName?: string;
	remoteRefresh?: true;
	ok: boolean | null;
	reason?: string;
	report?: Omit<UsageReport, "raw">;
	completion?: CredentialCompletionResult;
}

export interface CredentialCompletionResult {
	ok: boolean | null;
	reason?: string;
	modelId?: string;
	latencyMs?: number;
}

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

export interface CompletionProbeInput {
	provider: Provider;
	credentialId: number;
	credential: CompletionProbeCredential;
	signal: AbortSignal;
}

export type CompletionProbe = (input: CompletionProbeInput) => Promise<CredentialCompletionResult>;

export interface CheckCredentialsOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	credentialIds?: readonly number[];
	baseUrlResolver?: (provider: Provider) => string | undefined;
	completionProbe?: CompletionProbe;
	completionTimeoutMs?: number;
}

export const REMOTE_REFRESH_SENTINEL = "__remote__" as const;
export type RemoteRefreshSentinel = typeof REMOTE_REFRESH_SENTINEL;

export type RemoteOAuthCredential = Omit<OAuthCredential, "refresh"> & {
	refresh: RemoteRefreshSentinel;
};

export type SnapshotCredential = ApiKeyCredential | RemoteOAuthCredential;

export interface AuthCredentialSnapshotEntry {
	id: number;
	provider: string;
	credential: SnapshotCredential;
	identityKey: string | null;
}

export interface AuthCredentialSnapshot {
	generation: number;
	generatedAt: number;
	credentials: AuthCredentialSnapshotEntry[];
}

export interface CredentialRefreshLeaseFence {
	owner: string;
	nowMs: number;
}

export interface AuthCredentialStore {
	close(): void;
	invalidateUsageCache?(signal?: AbortSignal): Promise<void>;
	listAuthCredentials(provider?: string): StoredAuthCredential[];
	updateAuthCredential(id: number, credential: AuthCredential): void;
	updateAuthCredentialEnabling?(id: number, credential: AuthCredential): void;
	readAuthCredentialById?(id: number): StoredAuthCredential | undefined;
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
	deleteCachePrefix?(prefix: string): void;
	cleanExpiredCache(): void;
	getCredentialBlock?(credentialId: number, providerKey: string, blockScope: string): number | undefined;
	getCredentialBlockReconcileAfter?(credentialId: number, providerKey: string, blockScope: string): number | undefined;
	upsertCredentialBlock?(block: StoredCredentialBlock): void;
	deleteCredentialBlocks?(credentialId: number): void;
	cleanExpiredCredentialBlocks?(nowMs: number): void;
	listCredentialBlocks?(credentialIds: readonly number[]): StoredCredentialBlock[];
	getAccountName?(identity: string): string | undefined;
	listAccountNames?(): Array<{ identity: string; name: string }>;
	setAccountName?(identity: string, name: string): void;
	deleteAccountName?(identity: string): void;
	getProviderSelection?(provider: string): string | undefined;
	setProviderSelection?(provider: string, identity: string): void;
	clearProviderSelection?(provider: string): void;
	tryAcquireCredentialRefreshLease?(credentialId: number, owner: string, expiresAtMs: number): boolean;
	getCredentialRefreshLeaseExpiresAt?(credentialId: number): number | undefined;
	releaseCredentialRefreshLease?(credentialId: number, owner: string): void;
	renewCredentialRefreshLease?(credentialId: number, owner: string, expiresAtMs: number): boolean;
	recordUsageSnapshots?(entries: UsageHistoryEntry[]): void;
	recordUsageCosts?(entries: UsageCostHistoryEntry[]): void;
	listUsageCosts?(query?: UsageCostHistoryQuery): UsageCostHistoryEntry[];
	listUsageHistory?(query?: UsageHistoryQuery): UsageHistoryEntry[];
	refreshOAuthCredential?(
		provider: Provider,
		credentialId: number,
		credential: OAuthCredential,
		signal?: AbortSignal,
	): Promise<OAuthCredentials>;
	prepareForRequest?(credentialId: number, opts?: { signal?: AbortSignal }): Promise<boolean | undefined>;
	fetchUsageReports?(signal?: AbortSignal): Promise<UsageReport[] | null>;
	getUsageReport?(provider: Provider, credential: OAuthCredential, signal?: AbortSignal): Promise<UsageReport | null>;
	ingestUsageReport?(provider: Provider, credential: OAuthCredential, report: UsageReport): boolean;
	markCredentialSuspect?(credentialId: number, opts?: { signal?: AbortSignal }): Promise<void>;
	upsertAuthCredentialRemote?(provider: string, credential: AuthCredential): Promise<StoredAuthCredential[]>;
	replaceAuthCredentialsRemote?(provider: string, credentials: AuthCredential[]): Promise<StoredAuthCredential[]>;
	deleteAuthCredentialRemote?(id: number, disabledCause: string): Promise<boolean>;
	deleteAuthCredentialsRemote?(provider: string, disabledCause: string): Promise<void>;
}

export interface CredentialDisabledEvent {
	provider: string;
	disabledCause: string;
}

export interface CredentialFailoverEvent {
	provider: string;
	from: { credentialId: number; label: string };
	to: { credentialId: number; label: string };
	cause: string;
}

export interface UsageLimitWithheldEvent {
	provider: string;
	account: { credentialId: number; label: string };
	idleSiblings: number;
	retryAtMs: number;
}

export type AuthStorageOptions = {
	usageProviderResolver?: (provider: Provider) => UsageProvider | undefined;
	rankingStrategyResolver?: (provider: Provider) => CredentialRankingStrategy | undefined;
	usageFetch?: typeof fetch;
	usageRequestTimeoutMs?: number;
	usageLogger?: UsageLogger;
	configValueResolver?: (config: string) => Promise<string | undefined>;
	onCredentialDisabled?: (event: CredentialDisabledEvent) => void | Promise<void>;
	onCredentialFailover?: (event: CredentialFailoverEvent) => void | Promise<void>;
	onUsageLimitWithheld?: (event: UsageLimitWithheldEvent) => void | Promise<void>;
	loadBalancing?: boolean | (() => boolean);
	refreshOAuthCredential?: (
		provider: Provider,
		credentialId: number,
		credential: OAuthCredential,
		signal?: AbortSignal,
	) => Promise<OAuthCredentials>;
	sourceLabel?: string;
	fetchUsageReports?: (signal?: AbortSignal) => Promise<UsageReport[] | null>;
};

export async function defaultConfigValueResolver(config: string): Promise<string | undefined> {
	const envValue = process.env[config];
	return envValue || config;
}

export const USAGE_CACHE_PREFIX = "usage_cache:";
export const USAGE_HEADER_INGEST_INTERVAL_MS = 60_000;
export const USAGE_LAST_GOOD_RETENTION_MS = 24 * 60 * 60_000;
export const USAGE_FAILURE_BACKOFF_MS = 10_000;
export const DEFAULT_USAGE_REQUEST_TIMEOUT_MS = 10_000;
export const USAGE_REPORT_CACHE_KEY_VERSION_OVERRIDES: Partial<Record<Provider, number>> = {
	"google-antigravity": 2,
	zai: 2,
	anthropic: 2,
};
export const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 10_000;
export const OAUTH_REFRESH_SKEW_MS = 60_000;
export const OAUTH_REFRESH_LEASE_TTL_MS = 15_000;
export const OAUTH_REFRESH_LEASE_POLL_MS = 50;
export const OAUTH_REFRESH_LEASE_RENEW_MS = 5_000;
export const OAUTH_REFRESH_OPERATION_TIMEOUT_MS = 10_000;
export const MAX_PENDING_DISABLED_EVENTS = 32;
export const MAX_WITHHELD_QUOTA_NOTICES = 64;

export interface UsageLimitMarkResult {
	switched: boolean;
	retryAtMs?: number;
}

export type UsageCacheEntry<T> = {
	value: T;
	expiresAt: number;
};

export interface UsageCache {
	get<T>(key: string): UsageCacheEntry<T> | undefined;
	getStale<T>(key: string): UsageCacheEntry<T> | undefined;
	set<T>(key: string, entry: UsageCacheEntry<T>): void;
	cleanup?(): void;
}

export type UsageRequestDescriptor = {
	provider: Provider;
	credential: UsageCredential;
	baseUrl?: string;
};

export type AuthApiKeyOptions = {
	baseUrl?: string;
	modelId?: string;
	signal?: AbortSignal;
	forceRefresh?: boolean;
};
export type OAuthResolutionResult = { apiKey: string; credential: OAuthCredential; credentialId?: number };

export interface OAuthAccess {
	accessToken: string;
	credentialId?: number;
	accountId?: string;
	email?: string;
	projectId?: string;
	enterpriseUrl?: string;
	apiEndpoint?: string;
	orgId?: string;
	orgName?: string;
}

export interface OAuthLoginIdentity {
	type: "oauth" | "api_key";
	email?: string;
	accountId?: string;
	orgId?: string;
	orgName?: string;
	credentialId?: number;
}

export function storedCredentialSecret(credential: AuthCredential): string {
	return credential.type === "api_key" ? credential.key : credential.access;
}

export function matchStoredCredentialId(
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
	orgId?: string;
	orgName?: string;
	error: string;
}

export interface OAuthAccountIdentity {
	accountId?: string;
	email?: string;
	projectId?: string;
	orgId?: string;
	orgName?: string;
}

export type OAuthAccessResolution = ({ ok: true } & OAuthAccess) | ({ ok: false } & OAuthAccessFailure);

export interface OAuthAccountSummary {
	position: number;
	credentialId: number;
	accountId?: string;
	email?: string;
	projectId?: string;
	enterpriseUrl?: string;
	orgId?: string;
	orgName?: string;
}
export interface InvalidateCredentialMatchingOptions {
	signal?: AbortSignal;
	sessionId?: string;
}

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

export interface StoredOAuthRefreshResult<T extends OAuthCredential = OAuthCredential> {
	credential: T | undefined;
	refreshed: boolean;
	removed: boolean;
}

export interface ResetCreditTarget {
	credentialId?: number;
	accountId?: string;
	email?: string;
}

export interface ResetCreditRedeemOutcome {
	ok: boolean;
	code: CodexResetConsumeCode;
	accountId?: string;
	email?: string;
	creditId?: string;
}

export interface ResetCreditAccountStatus {
	credentialId?: number;
	accountId?: string;
	email?: string;
	availableCount: number;
	credits: CodexResetCredit[];
	active: boolean;
	error?: string;
}

export function isAbortSignalOption(
	value: InvalidateCredentialMatchingOptions | AbortSignal | undefined,
): value is AbortSignal {
	return typeof value === "object" && value !== null && "aborted" in value && "addEventListener" in value;
}

export type OpenAICodexPlanRequirement = "none" | "paid" | "pro";
export type OpenAICodexPlanClass = "free" | "paid" | "pro" | "unknown";

export const GPT_56_PAID_CODEX_MODEL_PATTERN = /^gpt-5\.6-(?:sol|luna)(?:-pro)?$/;
export const OPENAI_CODEX_PRO_PLAN_TOKENS: Record<string, true> = {
	pro: true,
};
export const OPENAI_CODEX_PAID_PLAN_TOKENS: Record<string, true> = {
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
export const OPENAI_CODEX_FREE_PLAN_TOKENS: Record<string, true> = {
	free: true,
	go: true,
};

export function resolveOpenAICodexPlanRequirement(
	provider: string,
	modelId: string | undefined,
): OpenAICodexPlanRequirement {
	if (provider !== "openai-codex" || typeof modelId !== "string") return "none";
	const separator = modelId.lastIndexOf("/");
	const bareModelId = (separator === -1 ? modelId : modelId.slice(separator + 1)).toLowerCase();
	if (bareModelId.includes("-spark")) return "pro";
	if (bareModelId === "gpt-5.6" || GPT_56_PAID_CODEX_MODEL_PATTERN.test(bareModelId)) return "paid";
	return "none";
}

export function getUsagePlanType(report: UsageReport | null): string | undefined {
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

export function classifyOpenAICodexPlan(report: UsageReport | null): OpenAICodexPlanClass {
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

export function getOpenAICodexPlanEligibility(
	report: UsageReport | null,
	requirement: OpenAICodexPlanRequirement,
): boolean | undefined {
	if (requirement === "none") return true;
	const planClass = classifyOpenAICodexPlan(report);
	if (planClass === "unknown") return undefined;
	return requirement === "paid" ? planClass !== "free" : planClass === "pro";
}

export function getOpenAICodexPlanPriority(
	report: UsageReport | null,
	requirement: OpenAICodexPlanRequirement,
): number {
	const eligibility = getOpenAICodexPlanEligibility(report, requirement);
	return eligibility === true ? 0 : eligibility === undefined ? 1 : 2;
}

export function compareUsageRankingMetric(left: number, right: number): number {
	if (left === right) return 0;
	if (!Number.isFinite(left) || !Number.isFinite(right)) return left < right ? -1 : 1;
	const delta = left - right;
	const tolerance = Math.max(USAGE_RANKING_METRIC_EPSILON, Math.max(Math.abs(left), Math.abs(right)) * 0.000001);
	return Math.abs(delta) <= tolerance ? 0 : delta;
}

export function resolveDefaultUsageProvider(provider: Provider): UsageProvider | undefined {
	return resolveRegisteredUsageProvider(provider);
}

export function resolveDefaultRankingStrategy(provider: Provider): CredentialRankingStrategy | undefined {
	return resolveRegisteredRankingStrategy(provider);
}

export function parseUsageCacheEntry<T>(raw: string): UsageCacheEntry<T> | undefined {
	try {
		const parsed = JSON.parse(raw) as { value?: T; expiresAt?: unknown };
		const expiresAt = typeof parsed.expiresAt === "number" ? parsed.expiresAt : undefined;
		if (!expiresAt || !Number.isFinite(expiresAt)) return undefined;
		return { value: parsed.value as T, expiresAt };
	} catch {
		return undefined;
	}
}

export function raceUsageWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
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

export function raceCredentialRefreshWithSignal<T>(
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

export class AuthStorageUsageCache implements UsageCache {
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

export type StoredCredential = { id: number; credential: AuthCredential };
export type CredentialSelection<T extends AuthCredential> = { credential: T; index: number };
export type OAuthSelection = CredentialSelection<OAuthCredential>;
export type ApiKeySelection = CredentialSelection<ApiKeyCredential>;
export type StoredOAuthSelection = { credentialId: number; credential: OAuthCredential; index: number };

export type UsageCandidate<T extends AuthCredential> = {
	selection: CredentialSelection<T>;
	usage: UsageReport | null;
	usageChecked: boolean;
};

export type OAuthCandidate = UsageCandidate<OAuthCredential>;
export type ApiKeyCandidate = UsageCandidate<ApiKeyCredential>;
export type UsageRankingResult<T extends AuthCredential> = UsageCandidate<T> & { blockedUntil: number | undefined };

export type UsageRankedCandidate<T extends AuthCredential> = UsageCandidate<T> & {
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
export type RankedOAuthCandidate = UsageRankedCandidate<OAuthCredential>;
export type RankedApiKeyCandidate = UsageRankedCandidate<ApiKeyCredential>;
