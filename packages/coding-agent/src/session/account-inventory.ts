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

export interface AccountUsageWindow {
	label: string;
	usedFraction?: number;
	resetsAtMs?: number;
	durationMs?: number;
}

export type AccountHealth = "ok" | "failed" | "unverifiable";

export interface AccountRow {
	provider: string;
	providerLabel: string;
	credentialId: number;
	type: "oauth" | "api_key";
	name?: string;
	email?: string;
	accountId?: string;
	orgId?: string;
	orgName?: string;
	projectId?: string;
	origin?: CredentialOrigin;
	health?: AccountHealth;
	healthReason?: string;
	blockedUntilMs?: number;
	planTier?: string;
	usage: AccountUsageWindow[];
	activeForSession: boolean;
	activeIsPrediction: boolean;
	selectedForProvider: boolean;
	tokenExpiresAtMs?: number;
	renewable?: boolean;
}

export const CREDENTIAL_ORIGIN_LABELS: Record<CredentialOriginKind, string> = {
	runtime: "--api-key",
	config: "config",
	oauth: "login",
	api_key: "api key",
	env: "env",
	fallback: "custom provider",
};

export function accountOriginLabel(row: AccountRow): string | undefined {
	if (!row.origin) return undefined;
	return row.origin.kind === "env" && row.origin.envVar
		? `env: ${row.origin.envVar}`
		: CREDENTIAL_ORIGIN_LABELS[row.origin.kind];
}

export interface ProviderAccounts {
	provider: string;
	label: string;
	rows: AccountRow[];
	disabledCause?: string;
}

export interface AccountInventory {
	providers: ProviderAccounts[];
	totalAccounts: number;
	unhealthyCount: number;
}

export interface BuildAccountInventoryOptions {
	sessionId?: string;
}

export function accountDisplayLabel(row: AccountRow): string {
	if (row.name) return row.name;
	if (row.email) return row.email;
	if (row.orgName) return row.orgName;
	if (row.accountId) return row.accountId;
	if (row.projectId) return row.projectId;
	if (row.orgId) return row.orgId;
	return `${row.providerLabel} credential #${row.credentialId}`;
}

export function accountIdentityDetail(row: AccountRow): string[] {
	const parts: string[] = [];
	if (row.name && row.email) parts.push(row.email);
	const orgName = row.orgName?.trim();
	const emailKey = row.email?.trim().toLowerCase();
	const orgRestatesEmail = Boolean(orgName && emailKey && orgName.toLowerCase().includes(emailKey));
	if (orgName && orgName !== row.name && !orgRestatesEmail) parts.push(`org ${orgName}`);
	else if (!orgName && row.orgId) parts.push(`org ${row.orgId}`);
	if (row.projectId && row.projectId !== accountDisplayLabel(row)) parts.push(`project ${row.projectId}`);
	if (!row.email && !orgName && !row.orgId && row.accountId && row.accountId !== accountDisplayLabel(row)) {
		parts.push(row.accountId);
	}
	return parts;
}

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
				const blockedUntil = authStorage.credentialBlockedUntil(provider, `${provider}:${row.type}`, index);
				if (blockedUntil !== undefined) row.blockedUntilMs = blockedUntil;
			}
		}
	}

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

export type AccountCredentialState = "valid" | "expiring" | "expired" | "blocked" | "refresh-failed";

export interface AccountCredentialStatus {
	state: AccountCredentialState;
	resetsAtMs?: number;
	renewable: boolean;
}

export const CREDENTIAL_EXPIRY_WARN_MS = 5 * 60_000;

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

export async function loadAccountInventory(
	authStorage: AuthStorage,
	options: BuildAccountInventoryOptions = {},
): Promise<AccountInventory> {
	await authStorage.reload();
	return buildAccountInventory(authStorage, options);
}

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
			if (!next.email && result.email) next.email = result.email;
			if (!next.accountId && result.accountId) next.accountId = result.accountId;
			if (!next.orgName && result.orgName) next.orgName = result.orgName;
			if (next.health === "failed") unhealthyCount += 1;
			return next;
		}),
	}));

	return { providers, totalAccounts: inventory.totalAccounts, unhealthyCount };
}

function usageWindowQualifier(limit: UsageLimit, windowLabel: string): string | undefined {
	const own = limit.label.trim();
	if (!own) return undefined;
	const parenthetical = /\(([^()]+)\)\s*$/.exec(own)?.[1]?.trim();
	if (parenthetical) return parenthetical;
	return own.toLowerCase().includes(windowLabel.toLowerCase()) ? undefined : own;
}

function usageWindowLabel(limit: UsageLimit): string {
	const windowLabel = limit.window?.label?.trim() || limit.scope.windowId?.trim();
	if (!windowLabel) return limit.label.trim();
	const qualifier = usageWindowQualifier(limit, windowLabel);
	return qualifier ? `${windowLabel} · ${qualifier}` : windowLabel;
}

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
				if (tiers.size === 1) next.planTier = Array.from(tiers)[0];
				return next;
			}),
		};
	});

	return { providers, totalAccounts: inventory.totalAccounts, unhealthyCount: inventory.unhealthyCount };
}

export function accountsForProvider(inventory: AccountInventory, provider: string): readonly AccountRow[] {
	return inventory.providers.find(entry => entry.provider === provider)?.rows ?? [];
}

export function activeSessionAccounts(inventory: AccountInventory): AccountRow[] {
	const active: AccountRow[] = [];
	for (const entry of inventory.providers) {
		for (const row of entry.rows) {
			if (row.activeForSession && !row.activeIsPrediction) active.push(row);
		}
	}
	return active;
}

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
