/**
 * Unified account model read by all account surfaces: one row per credential grouped by provider.
 * Synchronously reads stored state on disk; async health and usage passes enrich rows when available.
 */
// The barrel would add the streaming engine and every transport for one constant, so the
// disable-cause prefix comes from the module that declares it and the rest are types, erased.

import type {
	AuthStorage,
	CredentialHealthResult,
	CredentialOrigin,
	CredentialOriginKind,
	UsageLimit,
	UsageReport,
} from "@veyyon/ai";
import { OAUTH_REFRESH_FAILURE_DISABLE_PREFIX } from "@veyyon/ai/auth-credential-rows";
import { limitMatchesActiveAccount } from "../slash-commands/helpers/active-oauth-account";
import { formatDurationCoarse, formatProviderName } from "../slash-commands/helpers/format";

/** One usage window as an account row shows it. */
export interface AccountUsageWindow {
	/**
	 * Display label for this limit window, qualified to be unique within the account.
	 */
	label: string;
	/** 0..1 consumed, or undefined when the provider reported no figure. */
	usedFraction?: number;
	/** Epoch ms the window rolls over. */
	resetsAtMs?: number;
	/** Window length in ms when the provider states one. Orders the bars, shortest window first. */
	durationMs?: number;
}

/** Health of one credential as last probed. `undefined` means "not probed yet", never "fine". */
export type AccountHealth = "ok" | "failed" | "unverifiable";

/** One stored credential, as every account surface shows it. */
export interface AccountRow {
	provider: string;
	providerLabel: string;
	credentialId: number;
	type: "oauth" | "api_key";
	/** Name the user chose. Absent means they never named this account. */
	name?: string;
	email?: string;
	accountId?: string;
	orgId?: string;
	orgName?: string;
	projectId?: string;
	/** Which leg of the credential cascade supplies this row (login / env / api key). */
	origin?: CredentialOrigin;
	health?: AccountHealth;
	/** Upstream failure text when `health === "failed"`, or why it is unverifiable. */
	healthReason?: string;
	/** Epoch ms this credential becomes usable again while rate-limit blocked. */
	blockedUntilMs?: number;
	/**
	 * Subscription plan reported by the usage probe (`limit.scope.tier`), or undefined if unavailable.
	 */
	planTier?: string;
	usage: AccountUsageWindow[];
	/** True when this credential serves the session's next request for its provider. */
	activeForSession: boolean;
	/**
	 * True when active status is predicted based on routing rules rather than observed request traffic.
	 */
	activeIsPrediction: boolean;
	/**
	 * True when this credential is the globally persisted active choice for this provider.
	 */
	selectedForProvider: boolean;
	/**
	 * Expiry timestamp in epoch milliseconds for OAuth access tokens, read directly from storage.
	 */
	tokenExpiresAtMs?: number;
	/**
	 * True when a refresh token is present, allowing expired access tokens to renew automatically.
	 */
	renewable?: boolean;
}

/**
 * Compact origin labels for credential sources across all account surfaces.
 */
export const CREDENTIAL_ORIGIN_LABELS: Record<CredentialOriginKind, string> = {
	runtime: "--api-key",
	config: "config",
	oauth: "login",
	api_key: "api key",
	env: "env",
	fallback: "custom provider",
};

/** The origin tag for one row, naming the variable when an env var supplies it. */
export function accountOriginLabel(row: AccountRow): string | undefined {
	if (!row.origin) return undefined;
	return row.origin.kind === "env" && row.origin.envVar
		? `env: ${row.origin.envVar}`
		: CREDENTIAL_ORIGIN_LABELS[row.origin.kind];
}

/** Every account of one provider, in stored order. */
export interface ProviderAccounts {
	provider: string;
	label: string;
	rows: AccountRow[];
	/**
	 * Reason why the provider's credential was automatically disabled (e.g. rejected refresh token).
	 */
	disabledCause?: string;
}

export interface AccountInventory {
	/** Providers that hold at least one credential, alphabetical by label. */
	providers: ProviderAccounts[];
	totalAccounts: number;
	/** Rows whose last probe failed. Zero until a health pass has run. */
	unhealthyCount: number;
}

export interface BuildAccountInventoryOptions {
	/**
	 * Session whose live routing decides `activeForSession`.
	 *
	 * `selectedForProvider` does NOT depend on it: the choice is global, so the card shows it
	 * identically in a session, in a one-shot CLI run, and in a test with no session at all.
	 */
	sessionId?: string;
}

/**
 * Returns a display label for an account in precedence order:
 * user-assigned name, email, organization, account ID, or provider fallback.
 */
export function accountDisplayLabel(row: AccountRow): string {
	if (row.name) return row.name;
	if (row.email) return row.email;
	if (row.orgName) return row.orgName;
	if (row.accountId) return row.accountId;
	if (row.projectId) return row.projectId;
	if (row.orgId) return row.orgId;
	return `${row.providerLabel} credential #${row.credentialId}`;
}

/**
 * Returns secondary identity details (email, org, account ID) omitting whatever was used in the primary label.
 */
export function accountIdentityDetail(row: AccountRow): string[] {
	const parts: string[] = [];
	if (row.name && row.email) parts.push(row.email);
	// An org whose name is derived from the login says nothing the email did not. Anthropic names a
	// personal workspace "<email>'s Organization", so a real account rendered
	// `you@gmail.com · org you@gmail.com's Organization`, spending a third of the row restating the
	// address and then truncating. Suppressed when the org name CONTAINS the email, which is the
	// shape of every auto-generated one; a real org ("Example Org") shares no substring and survives.
	const orgName = row.orgName?.trim();
	const emailKey = row.email?.trim().toLowerCase();
	const orgRestatesEmail = Boolean(orgName && emailKey && orgName.toLowerCase().includes(emailKey));
	if (orgName && orgName !== row.name && !orgRestatesEmail) parts.push(`org ${orgName}`);
	// An org ID is only worth a slot when no name was recovered. It is a UUID, so it identifies the
	// subscription without describing it, and it is never shown beside a name that already did.
	else if (!orgName && row.orgId) parts.push(`org ${row.orgId}`);
	if (row.projectId && row.projectId !== accountDisplayLabel(row)) parts.push(`project ${row.projectId}`);
	if (!row.email && !orgName && !row.orgId && row.accountId && row.accountId !== accountDisplayLabel(row)) {
		parts.push(row.accountId);
	}
	return parts;
}

/**
 * Synchronously constructs the account inventory from a loaded AuthStorage with session routing applied.
 * Callers should use {@link loadAccountInventory} to ensure stored credentials are reloaded first.
 */
export function buildAccountInventory(
	authStorage: AuthStorage,
	options: BuildAccountInventoryOptions = {},
): AccountInventory {
	const { sessionId } = options;
	const byProvider = new Map<string, AccountRow[]>();

	for (const stored of authStorage.listStoredCredentials()) {
		const { provider, credential } = stored;
		const providerLabel = formatProviderName(provider);
		const row: AccountRow = {
			provider,
			providerLabel,
			credentialId: stored.id,
			type: credential.type,
			usage: [],
			activeForSession: false,
			activeIsPrediction: false,
			selectedForProvider: false,
		};
		const name = authStorage.getAccountName(provider, stored.id);
		if (name) row.name = name;
		if (credential.type === "oauth") {
			if (credential.email) row.email = credential.email;
			if (credential.accountId) row.accountId = credential.accountId;
			if (credential.orgId) row.orgId = credential.orgId;
			if (credential.orgName) row.orgName = credential.orgName;
			if (credential.projectId) row.projectId = credential.projectId;
			// A zero or non-finite `expires` is a credential written by a provider that does not
			// state one, not a token that expired at the epoch. Leaving the field absent says so.
			if (Number.isFinite(credential.expires) && credential.expires > 0) {
				row.tokenExpiresAtMs = credential.expires;
			}
			row.renewable = credential.refresh.trim().length > 0;
		}
		const origin = authStorage.getCredentialOrigin(provider);
		if (origin) row.origin = origin;
		const rows = byProvider.get(provider) ?? [];
		rows.push(row);
		byProvider.set(provider, rows);
	}

	for (const [provider, rows] of byProvider) {
		const routing = authStorage.sessionCredentialRouting(provider, sessionId);
		for (let index = 0; index < rows.length; index++) {
			const row = rows[index]!;
			if (routing?.activeCredentialId === row.credentialId) {
				row.activeForSession = true;
				row.activeIsPrediction = routing.activeIsPrediction === true;
			}
			if (routing?.selectedCredentialId === row.credentialId) {
				row.selectedForProvider = true;
				if (routing.selectedBlockedUntilMs !== undefined) row.blockedUntilMs = routing.selectedBlockedUntilMs;
			}
			if (row.blockedUntilMs === undefined) {
				// `${provider}:${type}` is the block key AuthStorage writes; the bare type matches
				// no row, so the rate-limit glyph and its countdown never appeared.
				const blockedUntil = authStorage.credentialBlockedUntil(provider, `${provider}:${row.type}`, index);
				if (blockedUntil !== undefined) row.blockedUntilMs = blockedUntil;
			}
		}
	}

	// Providers whose ONLY login was torn down hold no active credential, so the loop above never saw
	// them. They get an accountless entry carrying just the cause: without it, the total-loss case
	// renders as a provider you never signed into, which is precisely the silence being fixed.
	const failedRefreshes = new Map(
		authStorage.listProvidersWithFailedRefresh().map(entry => [entry.provider, entry.cause]),
	);
	for (const [provider] of failedRefreshes) {
		if (!byProvider.has(provider)) byProvider.set(provider, []);
	}

	const providers = [...byProvider.entries()]
		.map(([provider, rows]) => {
			const entry: ProviderAccounts = { provider, label: formatProviderName(provider), rows };
			const disabledCause = failedRefreshes.get(provider) ?? authStorage.disabledCredentialCause(provider);
			if (disabledCause) entry.disabledCause = disabledCause;
			return entry;
		})
		.sort((left, right) => left.label.localeCompare(right.label));

	return {
		providers,
		totalAccounts: providers.reduce((sum, entry) => sum + entry.rows.length, 0),
		unhealthyCount: 0,
	};
}

/**
 * Actionable lifecycle state for a credential (valid, expiring, expired, blocked, or refresh-failed).
 */
export type AccountCredentialState = "valid" | "expiring" | "expired" | "blocked" | "refresh-failed";

/** One credential's state, with the moment it ends by itself when there is one. */
export interface AccountCredentialStatus {
	state: AccountCredentialState;
	/**
	 * Epoch ms this state resolves without anyone doing anything: the rate-limit reset for
	 * `blocked`, the token's own expiry for `expiring`. Absent for the states that only a login
	 * ends, because a countdown against them would promise a recovery that never comes.
	 */
	resetsAtMs?: number;
	/** True when a stored refresh token means the state costs the user nothing. */
	renewable: boolean;
}

/**
 * Threshold (5 minutes) before token expiration when a warning state is surfaced in the UI.
 */
export const CREDENTIAL_EXPIRY_WARN_MS = 5 * 60_000;

/**
 * Evaluates actionable credential status in priority order:
 * rejected refresh, rate-limit block, expired token, and expiring token.
 */
export function accountCredentialStatus(row: AccountRow, nowMs: number): AccountCredentialStatus {
	const renewable = row.renewable === true;
	if (row.health === "failed" && row.healthReason?.startsWith(OAUTH_REFRESH_FAILURE_DISABLE_PREFIX)) {
		return { state: "refresh-failed", renewable };
	}
	if (row.blockedUntilMs !== undefined && row.blockedUntilMs > nowMs) {
		return { state: "blocked", resetsAtMs: row.blockedUntilMs, renewable };
	}
	if (row.tokenExpiresAtMs !== undefined) {
		if (row.tokenExpiresAtMs <= nowMs) return { state: "expired", renewable };
		if (row.tokenExpiresAtMs - nowMs <= CREDENTIAL_EXPIRY_WARN_MS) {
			return { state: "expiring", resetsAtMs: row.tokenExpiresAtMs, renewable };
		}
	}
	return { state: "valid", renewable };
}

/**
 * Returns a user-facing notice for non-renewable expiring/expired credentials,
 * remaining silent for auto-renewing or already-reported error states.
 */
export function credentialStateNote(row: AccountRow, nowMs: number): string | undefined {
	const status = accountCredentialStatus(row, nowMs);
	if (status.renewable) return undefined;
	if (status.state === "expired") return "the access token expired and no refresh token is stored";
	if (status.state === "expiring" && status.resetsAtMs !== undefined) {
		const left = formatDurationCoarse(status.resetsAtMs - nowMs);
		return `the access token expires in ${left} and no refresh token is stored`;
	}
	return undefined;
}

/**
 * Reloads the AuthStorage from disk and builds the account inventory, picking up external logins.
 */
export async function loadAccountInventory(
	authStorage: AuthStorage,
	options: BuildAccountInventoryOptions = {},
): Promise<AccountInventory> {
	await authStorage.reload();
	return buildAccountInventory(authStorage, options);
}

/**
 * Folds asynchronous credential health probe results into inventory rows, matching strictly by credential ID.
 */
export function applyCredentialHealth(
	inventory: AccountInventory,
	results: readonly CredentialHealthResult[],
): AccountInventory {
	const byId = new Map<number, CredentialHealthResult>();
	for (const result of results) byId.set(result.id, result);

	let unhealthyCount = 0;
	const providers = inventory.providers.map(entry => ({
		...entry,
		rows: entry.rows.map(row => {
			const result = byId.get(row.credentialId);
			if (!result) return row;
			const next: AccountRow = { ...row };
			next.health = result.ok === true ? "ok" : result.ok === false ? "failed" : "unverifiable";
			if (result.reason) next.healthReason = result.reason;
			// A probe can recover identity the stored credential never had (an OAuth row
			// written before email capture). Fill, never overwrite: the stored value is the
			// one the routing layer keys on.
			if (!next.email && result.email) next.email = result.email;
			if (!next.accountId && result.accountId) next.accountId = result.accountId;
			if (!next.orgName && result.orgName) next.orgName = result.orgName;
			if (next.health === "failed") unhealthyCount += 1;
			return next;
		}),
	}));

	return { providers, totalAccounts: inventory.totalAccounts, unhealthyCount };
}

/**
 * Extracts a distinguishing qualifier (e.g. model tier, parenthetical backend) from a usage limit label.
 */
function usageWindowQualifier(limit: UsageLimit, windowLabel: string): string | undefined {
	const own = limit.label.trim();
	if (!own) return undefined;
	const parenthetical = /\(([^()]+)\)\s*$/.exec(own)?.[1]?.trim();
	if (parenthetical) return parenthetical;
	// `Claude 5 Hour` against window `5 Hour` says nothing the window did not: the provider
	// prefixed its own name, and repeating it on every bar is noise, not identity.
	return own.toLowerCase().includes(windowLabel.toLowerCase()) ? undefined : own;
}

/**
 * Formats the display label for a usage bar, combining the window duration with its qualifier.
 */
function usageWindowLabel(limit: UsageLimit): string {
	const windowLabel = limit.window?.label?.trim() || limit.scope.windowId?.trim();
	if (!windowLabel) return limit.label.trim();
	const qualifier = usageWindowQualifier(limit, windowLabel);
	return qualifier ? `${windowLabel} · ${qualifier}` : windowLabel;
}

/** One usage window per limit, in the provider's own order. */
function usageWindowsFor(limits: readonly UsageLimit[]): AccountUsageWindow[] {
	const windows: AccountUsageWindow[] = [];
	for (const limit of limits) {
		const window: AccountUsageWindow = { label: usageWindowLabel(limit) };
		if (limit.amount.usedFraction !== undefined) window.usedFraction = limit.amount.usedFraction;
		if (limit.window?.resetsAt !== undefined) window.resetsAtMs = limit.window.resetsAt;
		if (limit.window?.durationMs !== undefined) window.durationMs = limit.window.durationMs;
		windows.push(window);
	}
	return windows;
}

/**
 * Deduplicates usage windows by label (keeping freshest) and sorts them shortest duration first.
 */
function orderUsageWindows(
	windows: readonly { window: AccountUsageWindow; fetchedAt: number }[],
): AccountUsageWindow[] {
	const freshest = new Map<string, { window: AccountUsageWindow; fetchedAt: number; position: number }>();
	for (const entry of windows) {
		const prior = freshest.get(entry.window.label);
		if (prior && prior.fetchedAt >= entry.fetchedAt) continue;
		freshest.set(entry.window.label, { ...entry, position: prior?.position ?? freshest.size });
	}
	return [...freshest.values()]
		.sort((left, right) => {
			const leftMs = left.window.durationMs;
			const rightMs = right.window.durationMs;
			if (leftMs === rightMs) return left.position - right.position;
			if (leftMs === undefined) return 1;
			if (rightMs === undefined) return -1;
			return leftMs - rightMs;
		})
		.map(entry => entry.window);
}

/**
 * Folds usage reports into inventory rows using account attribution matching,
 * attaching usage unconditionally when a provider has only a single credential.
 */
export function applyUsageReports(inventory: AccountInventory, reports: readonly UsageReport[]): AccountInventory {
	const providers = inventory.providers.map(entry => {
		const providerReports = reports.filter(report => report.provider === entry.provider);
		if (providerReports.length === 0) return entry;
		const soleCredential = entry.rows.length === 1;
		return {
			...entry,
			rows: entry.rows.map(row => {
				const identity = {
					...(row.accountId ? { accountId: row.accountId } : {}),
					...(row.email ? { email: row.email } : {}),
					...(row.projectId ? { projectId: row.projectId } : {}),
					...(row.orgId ? { orgId: row.orgId } : {}),
				};
				if (!soleCredential && Object.keys(identity).length === 0) return row;
				const collected: { window: AccountUsageWindow; fetchedAt: number }[] = [];
				const tiers = new Set<string>();
				for (const report of providerReports) {
					const matched = soleCredential
						? report.limits
						: report.limits.filter(limit => limitMatchesActiveAccount(report, limit, identity));
					const fetchedAt = Number.isFinite(report.fetchedAt) ? report.fetchedAt : 0;
					for (const window of usageWindowsFor(matched)) collected.push({ window, fetchedAt });
					for (const limit of matched) {
						const tier = limit.scope.tier?.trim();
						if (tier) tiers.add(tier);
					}
				}
				if (collected.length === 0) return row;
				const next = { ...row, usage: orderUsageWindows(collected) };
				// Only when the account's own limits agree on ONE tier. Anthropic reports several
				// windows per account and a Team seat can carry both a shared and a personal pool,
				// so two different tiers on one account means the label would have to pick a winner,
				// and a plan badge that picked wrong is worse than a row with no badge.
				if (tiers.size === 1) next.planTier = [...tiers][0];
				return next;
			}),
		};
	});

	return { providers, totalAccounts: inventory.totalAccounts, unhealthyCount: inventory.unhealthyCount };
}

/** The rows of one provider, or an empty list when it holds no credentials. */
export function accountsForProvider(inventory: AccountInventory, provider: string): readonly AccountRow[] {
	return inventory.providers.find(entry => entry.provider === provider)?.rows ?? [];
}

/**
 * Returns accounts for providers that have actively routed requests in the current session.
 */
export function activeSessionAccounts(inventory: AccountInventory): AccountRow[] {
	const active: AccountRow[] = [];
	for (const entry of inventory.providers) {
		for (const row of entry.rows) {
			if (row.activeForSession && !row.activeIsPrediction) active.push(row);
		}
	}
	return active;
}

/**
 * Returns the user-selected account when a different account is currently serving traffic for the provider.
 */
export function selectedButRotated(
	inventory: AccountInventory,
	provider: string,
): { chosen: AccountRow; serving: AccountRow } | undefined {
	const rows = accountsForProvider(inventory, provider);
	const chosen = rows.find(row => row.selectedForProvider);
	if (!chosen || chosen.activeForSession) return undefined;
	const serving = rows.find(row => row.activeForSession);
	return serving ? { chosen, serving } : undefined;
}
