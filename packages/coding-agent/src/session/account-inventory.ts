/** The account model every account surface reads: one row per stored CREDENTIAL, grouped by provider, with the session's routing folded in. */
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
	/** What the row calls this window, unique within the account. The provider's window label alone is NOT unique: Antigravity reports one daily counter per */
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
	/** The plan this account is on ("Max 20x", "Pro"), when the provider says so. Reported by the usage probe as `limit.scope.tier`, so it is absent until usage lands and */
	planTier?: string;
	usage: AccountUsageWindow[];
	/** True when this credential serves the session's next request for its provider. */
	activeForSession: boolean;
	/** True when {@link activeForSession} is a prediction rather than an observation. No request has gone out on this session yet, or the one that had cannot serve another, so the */
	activeIsPrediction: boolean;
	/** True when this is the account the user chose for this provider. GLOBAL and durable, not session state: the choice is stored beside the credentials, so it */
	selectedForProvider: boolean;
	/** Epoch ms this credential's access token stops being accepted. OAuth only: an api key carries no expiry, and a row without this field is not "expired */
	tokenExpiresAtMs?: number;
	/** True when a refresh token is stored, so {@link tokenExpiresAtMs} passing costs nothing. This is the difference between the two expiries a user can meet. A renewable token that */
	renewable?: boolean;
}

/** Compact tag for each leg of the credential cascade, as every account surface prints it. ONE owner, because the distinction it draws is load-bearing rather than cosmetic: an env var */
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
	/** Why this provider's most recent login was torn down, when a failed refresh did it. NOT a row: a disabled credential cannot be pinned, named or logged out, so putting it in the */
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
	/** Session whose live routing decides `activeForSession`. `selectedForProvider` does NOT depend on it: the choice is global, so the card shows it */
	sessionId?: string;
}

/** What to call an account, in the order a user recognises it. The chosen name wins because it is the only label the user authored. Everything after it */
export function accountDisplayLabel(row: AccountRow): string {
	if (row.name) return row.name;
	if (row.email) return row.email;
	if (row.orgName) return row.orgName;
	if (row.accountId) return row.accountId;
	if (row.projectId) return row.projectId;
	if (row.orgId) return row.orgId;
	return `${row.providerLabel} credential #${row.credentialId}`;
}

/** The identity line under an account's label: everything that tells two accounts apart which the label did not already say. */
export function accountIdentityDetail(row: AccountRow): string[] {
	const parts: string[] = [];
	if (row.name && row.email) parts.push(row.email);
	// An org whose name is derived from the login says nothing the email did not. Anthropic names a personal workspace "<email>'s Organization", so a real account rendered
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

/** Read every stored credential into rows, with this session's routing applied. Synchronous and network-free by contract: callers paint from this immediately, and the card */
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

	const providers = Array.from(byProvider.entries())
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

/** What state one credential is in, on the one axis a user can act on. `valid` is the only state that needs nothing. The other four each have exactly one remedy, and */
export type AccountCredentialState = "valid" | "expiring" | "expired" | "blocked" | "refresh-failed";

/** One credential's state, with the moment it ends by itself when there is one. */
export interface AccountCredentialStatus {
	state: AccountCredentialState;
	/** Epoch ms this state resolves without anyone doing anything: the rate-limit reset for `blocked`, the token's own expiry for `expiring`. Absent for the states that only a login */
	resetsAtMs?: number;
	/** True when a stored refresh token means the state costs the user nothing. */
	renewable: boolean;
}

/** How close to expiry a token has to be before the card says so, in ms. Wider than the 60s refresh skew `AuthStorage` uses on purpose. The skew is when the runtime */
export const CREDENTIAL_EXPIRY_WARN_MS = 5 * 60_000;

/** The state one row is in, highest remedy first. PRECEDENCE, and why it is this order. A refresh the provider REJECTED outranks everything: the */
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

/** The one sentence both account surfaces print about a credential's lifetime, or nothing. ONE OWNER because the card and the inline `/account status` block used to derive every row fact */
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

/** Load the credential store, then read it into rows. The entry point every surface uses. One `reload()` in one place, rather than a precondition each caller has to remember. It also */
export async function loadAccountInventory(
	authStorage: AuthStorage,
	options: BuildAccountInventoryOptions = {},
): Promise<AccountInventory> {
	await authStorage.reload();
	return buildAccountInventory(authStorage, options);
}

/** Fold probe results into an inventory, matching by credential row id. Matched by id and nothing else: a probe result carries an email and an account id, and */
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

/** What tells two limits of one account apart, beyond the window they share. Providers put this in three different places and none of them is `window.label`: */
function usageWindowQualifier(limit: UsageLimit, windowLabel: string): string | undefined {
	const own = limit.label.trim();
	if (!own) return undefined;
	const parenthetical = /\(([^()]+)\)\s*$/.exec(own)?.[1]?.trim();
	if (parenthetical) return parenthetical;
	// `Claude 5 Hour` against window `5 Hour` says nothing the window did not: the provider
	// prefixed its own name, and repeating it on every bar is noise, not identity.
	return own.toLowerCase().includes(windowLabel.toLowerCase()) ? undefined : own;
}

/** The label one usage bar wears. an Antigravity account reports three daily counters and rendered three bars all reading */
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

/** Every window of one account, each shown once, shortest window first. ORDERING is by the window's own length, not by the order the provider listed its limits in: */
function orderUsageWindows(
	windows: readonly { window: AccountUsageWindow; fetchedAt: number }[],
): AccountUsageWindow[] {
	const freshest = new Map<string, { window: AccountUsageWindow; fetchedAt: number; position: number }>();
	for (const entry of windows) {
		const prior = freshest.get(entry.window.label);
		if (prior && prior.fetchedAt >= entry.fetchedAt) continue;
		freshest.set(entry.window.label, { ...entry, position: prior?.position ?? freshest.size });
	}
	return Array.from(freshest.values())
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

/** Fold usage reports into an inventory. Attribution reuses `limitMatchesActiveAccount`, the same predicate `/usage` uses, rather */
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
				// Only when the account's own limits agree on ONE tier. Anthropic reports several windows per account and a Team seat can carry both a shared and a personal pool,
				if (tiers.size === 1) next.planTier = Array.from(tiers)[0];
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

/** Every provider actively routed for a session, which is what `/account` reports. A provider with credentials the session has never used is NOT in use: several providers */
export function activeSessionAccounts(inventory: AccountInventory): AccountRow[] {
	const active: AccountRow[] = [];
	for (const entry of inventory.providers) {
		for (const row of entry.rows) {
			if (row.activeForSession && !row.activeIsPrediction) active.push(row);
		}
	}
	return active;
}

/** The account a user chose for a provider whose traffic has since moved elsewhere. Returns the chosen row only when a DIFFERENT row is serving, which is the condition worth */
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
