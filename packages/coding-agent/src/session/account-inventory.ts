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
	 * What the row calls this window, unique within the account.
	 *
	 * The provider's window label alone is NOT unique: Antigravity reports one daily counter per
	 * backend and Codex reports a plan window beside a per-model one, so three limits arrive whose
	 * `window.label` is the same word. See {@link usageWindowLabel} for how the qualifier is added.
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
	/**
	 * True when {@link activeForSession} is a prediction rather than an observation.
	 *
	 * No request has gone out on this session yet, or the one that had cannot serve another, so the
	 * routing was answered by replaying the selection the next request would make. Surfaces say
	 * `serves next` instead of `serving` for it: the account is right, but nothing has been spent
	 * through it, and a provider that ranks accounts by remaining quota can still land elsewhere.
	 */
	activeIsPrediction: boolean;
	/**
	 * True when this is the account the user chose for this provider.
	 *
	 * GLOBAL and durable, not session state: the choice is stored beside the credentials, so it
	 * holds for every session and every profile on this machine until the user changes it. The
	 * card says so, because a per-session choice that silently reverted on the next launch is
	 * exactly what this replaced.
	 */
	selectedForProvider: boolean;
	/**
	 * Epoch ms this credential's access token stops being accepted.
	 *
	 * OAuth only: an api key carries no expiry, and a row without this field is not "expired
	 * unknown", it is a credential whose lifetime has no clock. Read straight off the stored
	 * credential, never from a probe, so it is available in the first synchronous frame.
	 */
	tokenExpiresAtMs?: number;
	/**
	 * True when a refresh token is stored, so {@link tokenExpiresAtMs} passing costs nothing.
	 *
	 * This is the difference between the two expiries a user can meet. A renewable token that
	 * expired renews on the next request and needs no action at all; a token with no refresh
	 * beside it is a login that has ended. Rendering both as "expired" is how a working account
	 * gets signed in again for no reason, and how a dead one gets waited on.
	 */
	renewable?: boolean;
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
	/**
	 * Session whose live routing decides `activeForSession`.
	 *
	 * `selectedForProvider` does NOT depend on it: the choice is global, so the card shows it
	 * identically in a session, in a one-shot CLI run, and in a test with no session at all.
	 */
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
 * What state one credential is in, on the one axis a user can act on.
 *
 * `valid` is the only state that needs nothing. The other four each have exactly one remedy, and
 * naming them apart is the whole point: a rate-limited account comes back on its own, a renewable
 * token that expired renews itself on the next request, a token with no refresh beside it needs a
 * login, and a refresh the provider rejected needs a login AND will keep failing until it gets
 * one. Collapsing any two of those into "expired" is how a healthy account gets re-authenticated
 * for nothing.
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
 * How close to expiry a token has to be before the card says so, in ms.
 *
 * Wider than the 60s refresh skew `AuthStorage` uses on purpose. The skew is when the runtime
 * decides to renew; this is when a reader is told, and a warning that appears one minute before
 * it matters is one nobody sees. Five minutes is long enough to read the card and act, short
 * enough that a token with an hour left is not flagged.
 */
export const CREDENTIAL_EXPIRY_WARN_MS = 5 * 60_000;

/**
 * The state one row is in, highest remedy first.
 *
 * PRECEDENCE, and why it is this order. A refresh the provider REJECTED outranks everything: the
 * credential is finished, and no clock running down changes that. A rate-limit block outranks
 * expiry because the row is unusable right now however fresh its token is. Only then does the
 * token's own clock matter, and a token whose expiry has passed is reported ahead of one merely
 * approaching it.
 *
 * A row whose health is `failed` for a reason that is NOT a refresh failure stays `valid` here.
 * Its glyph and its verbatim reason already say a probe failed, and a probe failure is not a
 * statement about the credential's lifetime: an outage would otherwise read as an expired login.
 * `unverifiable` says the same thing more weakly and is likewise not a credential state.
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
 * The one sentence both account surfaces print about a credential's lifetime, or nothing.
 *
 * ONE OWNER because the card and the inline `/account status` block used to derive every row fact
 * separately, and that is what let them disagree. The remedy is deliberately NOT in it: the card
 * offers `press a`, the inline block offers `/providers`, and a shared sentence naming the wrong
 * one is worse than two sentences agreeing on the fact.
 *
 * SILENT for every state a user cannot act on, which is most of them. A renewable token renews
 * itself, so its expiry is bookkeeping and printing it would put a warning under a working
 * account; a rate-limit block and a rejected refresh already have their own line on both
 * surfaces. What is left is the case with no other voice: a token running out with no refresh
 * token stored, which ends the login when it lands.
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

/**
 * What tells two limits of one account apart, beyond the window they share.
 *
 * Providers put this in three different places and none of them is `window.label`:
 * Antigravity names the backend counter in the limit label (`Usage (Google)`), Codex names the
 * model tier the same way (`7 days (Spark)`), Claude names the model family (`Claude 7 Day
 * (Opus)`), and GitHub Copilot gives three limits one reset window and distinguishes them only by
 * the limit label (`Premium Requests`). A trailing parenthetical is the qualifier when there is
 * one; otherwise the limit's own label is, unless it merely restates the window.
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
 * The label one usage bar wears.
 *
 * WHY THIS IS NOT `limit.window.label`. It used to be, and that is the whole single-window bug:
 * an Antigravity account reports three daily counters and rendered three bars all reading
 * `Daily`, a Codex account reports its plan window and a Spark window and rendered `7 days`
 * twice. Bars that cannot be told apart read as one window repeated, which is exactly what was
 * reported — "usage shows one window when the account has more". The window still leads the
 * label, because that is what a user scans for; the qualifier follows it.
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
 * Every window of one account, each shown once, shortest window first.
 *
 * ORDERING is by the window's own length, not by the order the provider listed its limits in:
 * `5 Hour` before `7 Day`, `Daily` before `Weekly`. Antigravity sorts its limits by remaining
 * fraction and Claude emits the umbrella windows before the model-scoped ones, so provider order
 * puts a weekly bar above an hourly one for no reason the reader can see. A window whose length
 * the provider never stated sorts last, because there is nothing to place it against.
 *
 * DEDUPING is by label, keeping the freshest reading. Two reports for the same account reach here
 * routinely — the header-ingested snapshot and the endpoint fetch are separate cache rows — and
 * without this the card showed `5 Hour, 7 Day, 5 Hour, 7 Day`.
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
 * Fold usage reports into an inventory.
 *
 * Attribution reuses `limitMatchesActiveAccount`, the same predicate `/usage` uses, rather
 * than a second rule: it is the one place that knows an org gates an email match, so two
 * Anthropic subscriptions sharing a login do not both claim each other's limits. Only the
 * limit COLUMNS that match a row are attached to it, because one report can carry limits for
 * several accounts at once.
 *
 * EXCEPT when the provider holds exactly one credential, where identity matching is skipped
 * entirely. Matching exists to arbitrate between siblings, and a provider with no sibling has
 * nothing to arbitrate: the usage fan-out builds one request per stored credential, so a report
 * for a single-credential provider can only be that credential's. Requiring a match there is how
 * an account whose stored credential carries no email or account id (Cursor, Kimi and xAI store
 * none) showed no usage at all, and how an Anthropic row carrying an `orgId` the report's
 * metadata omits lost every window it had.
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
 * Every provider actively routed for a session, which is what `/account` reports.
 *
 * A provider with credentials the session has never used is NOT in use: several providers
 * serve one session at once (main model, subagent roles, web search), so the honest answer
 * to "which account am I on" is one row per provider that has actually routed, not a list of
 * everything configured.
 *
 * `selectedForProvider` is deliberately NOT consulted. The choice an operator makes on the
 * account card is persisted for good and shared by every profile on the machine, so reading it
 * here would report a provider chosen months ago in another session as one this session is
 * spending, and would hand `/account refresh` and `/account name` an account the operator never
 * routed. A standing choice is a prediction about the NEXT request; `selectedButRotated` is where
 * it earns a mention, and only once something else is actually serving.
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
 * The account a user chose for a provider whose traffic has since moved elsewhere.
 *
 * Returns the chosen row only when a DIFFERENT row is serving, which is the condition worth
 * reporting: the account changed without the user asking. Both rows are returned so the
 * caller can name what it swapped to.
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
