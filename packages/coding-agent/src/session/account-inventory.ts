/**
 * The account model every account surface reads: one row per stored CREDENTIAL, grouped by
 * provider, with the session's routing folded in.
 *
 * WHY THIS EXISTS AS ITS OWN MODULE. Three surfaces need the same answer and used to derive
 * their own: the account manager card, the inline `/account status` block, and the ACP text
 * form of the same command. Each of them asking `AuthStorage` directly is how the three
 * drifted before, with the provider list showing one row per PROVIDER while `/usage` showed
 * one per account. Building the model once, here, is what keeps them agreeing.
 *
 * WHAT IT DOES NOT DO. No network, no clock, no theme, no ANSI. `buildAccountInventory` is a
 * synchronous read of what is already on disk, so a card can paint immediately; the two
 * enrichment passes ({@link applyCredentialHealth}, {@link applyUsageReports}) fold in the
 * slow answers when they arrive. That split is what lets the manager render in one frame and
 * fill in health and usage without blocking, and it is what lets tests assert exact rows
 * against fixed inputs with no probes running.
 */
import type {
	AuthStorage,
	CredentialHealthResult,
	CredentialOrigin,
	CredentialOriginKind,
	UsageLimit,
	UsageReport,
} from "@veyyon/ai";
import { limitMatchesActiveAccount } from "../slash-commands/helpers/active-oauth-account";
import { formatProviderName } from "../slash-commands/helpers/format";

/** One usage window as an account row shows it. */
export interface AccountUsageWindow {
	/** Provider's own label for the window ("5h", "Claude 7 Day"). */
	label: string;
	/** 0..1 consumed, or undefined when the provider reported no figure. */
	usedFraction?: number;
	/** Epoch ms the window rolls over. */
	resetsAtMs?: number;
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
	 * The plan this account is on ("Max 20x", "Pro"), when the provider says so.
	 *
	 * Reported by the usage probe as `limit.scope.tier`, so it is absent until usage lands and
	 * absent for providers that do not tier their limits. It is never guessed from the quota
	 * size: two accounts on different plans can show the same remaining fraction, and a
	 * confidently wrong plan label is worse than none.
	 */
	planTier?: string;
	usage: AccountUsageWindow[];
	/** True when this credential serves the session's next request for its provider. */
	activeForSession: boolean;
	/** True when the user explicitly pinned this credential for the session. */
	pinnedForSession: boolean;
}

/**
 * Compact tag for each leg of the credential cascade, as every account surface prints it.
 *
 * ONE owner, because the distinction it draws is load-bearing rather than cosmetic: an env var
 * that happens to alias a provider must never render like a deliberate login, or a user cannot
 * tell why unsetting a shell variable logged them out. It lives here, in the pure seam, so the
 * inline `/account status` renderer can use it without importing a TUI component.
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
	 * Why this provider's most recent login was torn down, when a failed refresh did it.
	 *
	 * NOT a row: a disabled credential cannot be pinned, named or logged out, so putting it in the
	 * account list would add an entry most keys do nothing to. It is a note about the provider.
	 *
	 * It is here because a disabled credential is invisible everywhere else. `listAuthCredentials`
	 * filters disabled rows, so a provider whose only login died reads as one you never signed into,
	 * and the user is told to log in without being told that the login they had was thrown away or
	 * why. `AuthStorage.disabledCredentialCause` already narrows this to refresh failures, which are
	 * the disables the user did not perform and has not been told about; a logout or a superseded
	 * duplicate stays silent because they already know.
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
	/** Session whose routing decides `activeForSession` / `pinnedForSession`. */
	sessionId?: string;
}

/**
 * What to call an account, in the order a user recognises it.
 *
 * The chosen name wins because it is the only label the user authored. Everything after it
 * is the account identifying itself: the email is what a person recognises, the org
 * disambiguates two subscriptions that share one email, and the opaque ids are last because
 * they identify the account without describing it. The final fallback names the provider and
 * row so a label is never empty, which matters most for api-key rows that carry no identity
 * at all.
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
 * The identity line under an account's label: everything that tells two accounts apart
 * which the label did not already say.
 *
 * Deliberately skips whatever `accountDisplayLabel` used, so a named account reads
 * "work / first@example.com" and an unnamed one does not read "first@example.com /
 * first@example.com". Two subscriptions on one email differ only by org, which is why the
 * org survives even when it was the label.
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
 * Read every stored credential into rows, with this session's routing applied.
 *
 * Synchronous and network-free by contract: callers paint from this immediately, and the card
 * re-builds through it on every probe that lands.
 *
 * REQUIRES A LOADED `AuthStorage`, which is why {@link loadAccountInventory} exists and is what
 * every entry point should call. `AuthStorage` keeps its credentials in an in-memory map that
 * only `reload()` fills, and `AuthStorage.create()` does NOT reload, so this function returns
 * ZERO rows against a freshly constructed instance whose database holds ten accounts. That is
 * not hypothetical: a live run against a real store reported "0 active credential rows" while
 * the health probe, which reads the store directly, found nine. An account manager that shows a
 * multi-account user no accounts is the worst failure this surface has, and it is silent.
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
			pinnedForSession: false,
		};
		const name = authStorage.getAccountName(provider, stored.id);
		if (name) row.name = name;
		if (credential.type === "oauth") {
			if (credential.email) row.email = credential.email;
			if (credential.accountId) row.accountId = credential.accountId;
			if (credential.orgId) row.orgId = credential.orgId;
			if (credential.orgName) row.orgName = credential.orgName;
			if (credential.projectId) row.projectId = credential.projectId;
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
			if (routing?.activeCredentialId === row.credentialId) row.activeForSession = true;
			if (routing?.pinnedCredentialId === row.credentialId) {
				row.pinnedForSession = true;
				if (routing.pinnedBlockedUntilMs !== undefined) row.blockedUntilMs = routing.pinnedBlockedUntilMs;
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
 * Load the credential store, then read it into rows. The entry point every surface uses.
 *
 * One `reload()` in one place, rather than a precondition each caller has to remember. It also
 * buys a second thing worth having: a login completed in another process, or by `veyyon
 * auth-broker login` in a shell, is on disk but not in this process's map, so opening the manager
 * picks it up instead of showing a stale account list.
 */
export async function loadAccountInventory(
	authStorage: AuthStorage,
	options: BuildAccountInventoryOptions = {},
): Promise<AccountInventory> {
	await authStorage.reload();
	return buildAccountInventory(authStorage, options);
}

/**
 * Fold probe results into an inventory, matching by credential row id.
 *
 * Matched by id and nothing else: a probe result carries an email and an account id, and
 * matching on those would attribute one account's failure to another whenever two rows share
 * an email, which is exactly the Anthropic two-subscription case. The id is the only
 * identifier that is unique per row.
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

/** One usage window per limit, in the provider's own order. */
function usageWindowsFor(limits: readonly UsageLimit[]): AccountUsageWindow[] {
	const windows: AccountUsageWindow[] = [];
	for (const limit of limits) {
		const window: AccountUsageWindow = { label: limit.window?.label ?? limit.scope.windowId ?? limit.label };
		if (limit.amount.usedFraction !== undefined) window.usedFraction = limit.amount.usedFraction;
		if (limit.window?.resetsAt !== undefined) window.resetsAtMs = limit.window.resetsAt;
		windows.push(window);
	}
	return windows;
}

/**
 * Fold usage reports into an inventory.
 *
 * Attribution reuses `limitMatchesActiveAccount`, the same predicate `/usage` uses, rather
 * than a second rule: it is the one place that knows an org gates an email match, so two
 * Anthropic subscriptions sharing a login do not both claim each other's limits. Only the
 * limit COLUMNS that match a row are attached to it, because one report can carry limits for
 * several accounts at once.
 */
export function applyUsageReports(inventory: AccountInventory, reports: readonly UsageReport[]): AccountInventory {
	const providers = inventory.providers.map(entry => {
		const providerReports = reports.filter(report => report.provider === entry.provider);
		if (providerReports.length === 0) return entry;
		return {
			...entry,
			rows: entry.rows.map(row => {
				const identity = {
					...(row.accountId ? { accountId: row.accountId } : {}),
					...(row.email ? { email: row.email } : {}),
					...(row.projectId ? { projectId: row.projectId } : {}),
					...(row.orgId ? { orgId: row.orgId } : {}),
				};
				if (Object.keys(identity).length === 0) return row;
				const usage: AccountUsageWindow[] = [];
				const tiers = new Set<string>();
				for (const report of providerReports) {
					const matched = report.limits.filter(limit => limitMatchesActiveAccount(report, limit, identity));
					if (matched.length > 0) usage.push(...usageWindowsFor(matched));
					for (const limit of matched) {
						const tier = limit.scope.tier?.trim();
						if (tier) tiers.add(tier);
					}
				}
				if (usage.length === 0) return row;
				const next = { ...row, usage };
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
 * Every provider actively routed for a session, which is what `/account` reports.
 *
 * A provider with credentials the session has never used is NOT in use: several providers
 * serve one session at once (main model, subagent roles, web search), so the honest answer
 * to "which account am I on" is one row per provider that has actually routed, not a list of
 * everything configured.
 */
export function activeSessionAccounts(inventory: AccountInventory): AccountRow[] {
	const active: AccountRow[] = [];
	for (const entry of inventory.providers) {
		for (const row of entry.rows) {
			if (row.activeForSession || row.pinnedForSession) active.push(row);
		}
	}
	return active;
}

/**
 * The row a user pinned for a provider whose traffic has since moved elsewhere.
 *
 * Returns the pinned row only when a DIFFERENT row is serving, which is the condition worth
 * reporting: the account changed without the user asking. Both rows are returned so the
 * caller can name what it swapped to.
 */
export function pinnedButRotated(
	inventory: AccountInventory,
	provider: string,
): { pinned: AccountRow; serving: AccountRow } | undefined {
	const rows = accountsForProvider(inventory, provider);
	const pinned = rows.find(row => row.pinnedForSession);
	if (!pinned || pinned.activeForSession) return undefined;
	const serving = rows.find(row => row.activeForSession);
	return serving ? { pinned, serving } : undefined;
}
