/**
 * GitHub Copilot usage provider.
 *
 * Normalizes Copilot quota usage into the shared UsageReport schema.
 */

import { toBoolean, toNumber } from "@veyyon/catalog/utils";
import { GITHUB_REST_HEADERS, OPENCODE_HEADERS } from "@veyyon/catalog/wire/github-copilot";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import * as AIError from "../error";
import type {
	UsageAmount,
	UsageCredential,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageWindow,
} from "../usage";
import { isRecord } from "../utils";
import { fetchGitHubCopilotJson } from "../utils/github-copilot-http";

type CopilotQuotaDetail = {
	entitlement: number;
	overage_count: number;
	overage_permitted: boolean;
	percent_remaining: number;
	quota_id: string;
	quota_remaining: number;
	remaining: number;
	unlimited: boolean;
};

type CopilotQuotaSnapshots = {
	chat?: CopilotQuotaDetail;
	completions?: CopilotQuotaDetail;
	premium_interactions?: CopilotQuotaDetail;
};

type CopilotUsageResponse = {
	copilot_plan: string;
	quota_reset_date: string;
	quota_snapshots: CopilotQuotaSnapshots;
};

type BillingUsageItem = {
	product: string;
	sku: string;
	model?: string;
	unitType: string;
	grossQuantity: number;
	netQuantity: number;
	limit?: number;
};

type BillingUsageResponse = {
	timePeriod: { year: number; month?: number };
	user: string;
	usageItems: BillingUsageItem[];
};

function resolveGitHubApiBaseUrl(params: UsageFetchParams): string {
	const baseUrl = params.baseUrl ? trimTrailingSlashes(params.baseUrl) : undefined;
	if (baseUrl && !baseUrl.includes("githubcopilot.com")) return baseUrl;
	const enterpriseUrl = params.credential.enterpriseUrl?.trim();
	if (!enterpriseUrl) return "https://api.github.com";
	if (enterpriseUrl.startsWith("http://") || enterpriseUrl.startsWith("https://")) {
		return trimTrailingSlashes(enterpriseUrl);
	}
	if (enterpriseUrl.startsWith("api.")) {
		return `https://${enterpriseUrl}`;
	}
	return `https://api.${enterpriseUrl}`;
}

function buildWindow(resetDate: string | undefined): UsageWindow | undefined {
	if (!resetDate) return undefined;
	const resetAt = Date.parse(resetDate);
	if (!Number.isFinite(resetAt)) return undefined;
	return {
		id: "monthly",
		label: "Monthly",
		resetsAt: resetAt,
	};
}

function buildAmount(used: number | undefined, limit: number | undefined, unit: UsageAmount["unit"]): UsageAmount {
	const safeLimit = limit !== undefined && Number.isFinite(limit) ? limit : undefined;
	const safeUsed = used !== undefined && Number.isFinite(used) ? used : undefined;
	const remaining = safeLimit !== undefined && safeUsed !== undefined ? Math.max(0, safeLimit - safeUsed) : undefined;
	const usedFraction =
		safeLimit !== undefined && safeUsed !== undefined && safeLimit > 0 ? safeUsed / safeLimit : undefined;
	const remainingFraction =
		safeLimit !== undefined && remaining !== undefined && safeLimit > 0 ? remaining / safeLimit : undefined;
	return {
		used: safeUsed,
		limit: safeLimit,
		remaining,
		usedFraction,
		remainingFraction,
		unit,
	};
}

function deriveStatus(amount: UsageAmount, unlimited: boolean): UsageStatus {
	if (unlimited) return "ok";
	if (amount.remainingFraction === undefined) return "unknown";
	if (amount.remainingFraction <= 0) return "exhausted";
	if (amount.remainingFraction <= 0.1) return "warning";
	return "ok";
}

function parseQuotaDetail(value: unknown): CopilotQuotaDetail | null {
	if (!isRecord(value)) return null;
	const entitlement = toNumber(value.entitlement);
	const remaining = toNumber(value.remaining);
	const percentRemaining = toNumber(value.percent_remaining);
	const unlimited = toBoolean(value.unlimited);
	if (
		entitlement === undefined ||
		remaining === undefined ||
		percentRemaining === undefined ||
		unlimited === undefined
	) {
		return null;
	}
	const overageCount = toNumber(value.overage_count) ?? 0;
	const overagePermitted = toBoolean(value.overage_permitted) ?? false;
	const quotaId = typeof value.quota_id === "string" ? value.quota_id : "";
	const quotaRemaining = toNumber(value.quota_remaining) ?? remaining;
	return {
		entitlement,
		overage_count: overageCount,
		overage_permitted: overagePermitted,
		percent_remaining: percentRemaining,
		quota_id: quotaId,
		quota_remaining: quotaRemaining,
		remaining,
		unlimited,
	};
}

async function resolveGitHubUsername(
	ctx: UsageFetchContext,
	baseUrl: string,
	token: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	try {
		const data = await fetchGitHubCopilotJson(ctx.fetch, `${baseUrl}/user`, {
			headers: {
				...GITHUB_REST_HEADERS,
				Authorization: `Bearer ${token}`,
			},
			signal,
		});
		if (!isRecord(data)) return undefined;
		return typeof data.login === "string" ? data.login : undefined;
	} catch {
		// The login only LABELS a usage row. Undefined means the row is shown without a name, the same as a
		// response with no `login` field, and the usage numbers beside it are unaffected.
		return undefined;
	}
}

async function fetchInternalUsage(
	ctx: UsageFetchContext,
	githubApiBaseUrl: string,
	token: string,
	signal?: AbortSignal,
): Promise<CopilotUsageResponse> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json",
		Authorization: `Bearer ${token}`,
		...OPENCODE_HEADERS,
	};
	const data = await fetchGitHubCopilotJson(ctx.fetch, `${githubApiBaseUrl}/copilot_internal/user`, {
		headers,
		signal,
	});
	if (!isRecord(data)) throw new AIError.ProviderHttpError("Invalid Copilot usage response", 200);
	return data as CopilotUsageResponse;
}

async function fetchBillingUsage(
	ctx: UsageFetchContext,
	baseUrl: string,
	username: string,
	token: string,
	signal?: AbortSignal,
): Promise<BillingUsageResponse> {
	const data = await fetchGitHubCopilotJson(
		ctx.fetch,
		`${baseUrl}/users/${encodeURIComponent(username)}/settings/billing/premium_request/usage`,
		{
			headers: {
				...GITHUB_REST_HEADERS,
				Authorization: `Bearer ${token}`,
			},
			signal,
		},
	);

	if (!isRecord(data)) throw new AIError.ProviderHttpError("Invalid Copilot billing usage response", 200);
	return data as BillingUsageResponse;
}

function buildLimitFromQuota(
	key: string,
	label: string,
	quota: CopilotQuotaDetail,
	plan: string,
	window: UsageWindow | undefined,
	accountId?: string,
): UsageLimit {
	const used = quota.unlimited ? undefined : Math.max(0, quota.entitlement - quota.remaining);
	const limit = quota.unlimited ? undefined : quota.entitlement;
	const amount = buildAmount(used, limit, "requests");
	const notes: string[] = [];
	if (quota.unlimited) notes.push("Unlimited");
	if (quota.overage_count > 0) {
		notes.push(`Overage requests: ${quota.overage_count}`);
	}
	return {
		id: `copilot:${key}`,
		label,
		scope: {
			provider: "github-copilot",
			accountId,
			tier: plan,
			windowId: window?.id,
		},
		window,
		amount,
		status: deriveStatus(amount, quota.unlimited),
		notes: notes.length > 0 ? notes : undefined,
	};
}

function normalizeQuotaSnapshots(data: CopilotUsageResponse, accountId?: string): UsageLimit[] {
	const window = buildWindow(data.quota_reset_date);
	const snapshots = data.quota_snapshots ?? {};
	const limits: UsageLimit[] = [];
	const premium = parseQuotaDetail(snapshots.premium_interactions);
	if (premium) {
		limits.push(buildLimitFromQuota("premium", "Premium Requests", premium, data.copilot_plan, window, accountId));
	}
	const chat = parseQuotaDetail(snapshots.chat);
	if (chat && !chat.unlimited) {
		limits.push(buildLimitFromQuota("chat", "Chat Requests", chat, data.copilot_plan, window, accountId));
	}
	const completions = parseQuotaDetail(snapshots.completions);
	if (completions && !completions.unlimited) {
		limits.push(buildLimitFromQuota("completions", "Completions", completions, data.copilot_plan, window, accountId));
	}
	return limits;
}

function normalizeBillingUsage(data: BillingUsageResponse): UsageLimit[] {
	const limits: UsageLimit[] = [];
	const periodLabel = data.timePeriod.month
		? `${data.timePeriod.year}-${String(data.timePeriod.month).padStart(2, "0")}`
		: `${data.timePeriod.year}`;
	const window: UsageWindow = {
		id: "billing-period",
		label: periodLabel,
	};

	const premiumItems = data.usageItems.filter(
		item => item.sku === "Copilot Premium Request" || item.sku.includes("Premium"),
	);
	const totalUsed = premiumItems.reduce((sum, item) => sum + item.grossQuantity, 0);
	const totalLimit = premiumItems.reduce((sum, item) => sum + (item.limit ?? 0), 0) || undefined;
	const totalAmount = buildAmount(totalUsed, totalLimit, "requests");
	limits.push({
		id: "copilot:premium",
		label: "Premium Requests",
		scope: {
			provider: "github-copilot",
			accountId: data.user,
			windowId: window.id,
		},
		window,
		amount: totalAmount,
		status: deriveStatus(totalAmount, false),
	});

	for (const item of data.usageItems) {
		if (!item.model) continue;
		if (item.grossQuantity <= 0) continue;
		const amount = buildAmount(item.grossQuantity, item.limit, "requests");
		limits.push({
			id: `copilot:model:${item.model}`,
			label: `Model ${item.model}`,
			scope: {
				provider: "github-copilot",
				accountId: data.user,
				modelId: item.model,
				windowId: window.id,
			},
			window,
			amount,
			status: deriveStatus(amount, false),
		});
	}

	return limits;
}

/** A report read, or `null` after logging the error that ended the read. */
async function readUsageReport(ctx: UsageFetchContext, read: () => Promise<UsageReport>): Promise<UsageReport | null> {
	try {
		return await read();
	} catch (error) {
		ctx.logger?.warn("Copilot usage fetch failed", { error: String(error) });
		return null;
	}
}

function buildQuotaReport(
	usage: CopilotUsageResponse,
	accountId: string | undefined,
	identity: Record<string, unknown>,
): UsageReport {
	const limits = normalizeQuotaSnapshots(usage, accountId);
	return {
		provider: "github-copilot",
		fetchedAt: Date.now(),
		limits,
		metadata: { ...identity, plan: usage.copilot_plan, quotaResetDate: usage.quota_reset_date },
		raw: usage,
	};
}

/** The billing login the credential states in `accountId`, `metadata.username` or `metadata.user`. */
function credentialUsername(credential: UsageCredential): string | undefined {
	const candidate = credential.accountId || credential.metadata?.username || credential.metadata?.user;
	return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

/**
 * An API key reads the premium-request billing report for its login, stated by the credential or
 * resolved from `/user`; without a login, or when the billing read fails, it reads the Copilot quota.
 */
async function fetchApiKeyUsage(
	params: UsageFetchParams,
	ctx: UsageFetchContext,
	baseUrl: string,
	apiKey: string,
): Promise<UsageReport | null> {
	const username =
		credentialUsername(params.credential) ?? (await resolveGitHubUsername(ctx, baseUrl, apiKey, params.signal));
	if (username) {
		const billingReport = await readUsageReport(ctx, async () => {
			const billing = await fetchBillingUsage(ctx, baseUrl, username, apiKey, params.signal);
			return {
				provider: "github-copilot",
				fetchedAt: Date.now(),
				limits: normalizeBillingUsage(billing),
				metadata: { accountId: billing.user, account: billing.user, period: billing.timePeriod },
			};
		});
		if (billingReport) return billingReport;
	} else {
		ctx.logger?.warn("Copilot usage requires username for billing API", { provider: params.provider });
	}
	return readUsageReport(ctx, async () => {
		const usage = await fetchInternalUsage(ctx, baseUrl, apiKey, params.signal);
		return buildQuotaReport(usage, username, { accountId: username });
	});
}

/** The credential's account id, else the login the refresh token and then the access token resolve to. */
async function resolveOAuthAccountId(
	params: UsageFetchParams,
	ctx: UsageFetchContext,
	baseUrl: string,
): Promise<string | undefined> {
	const { accountId, refreshToken, accessToken } = params.credential;
	if (accountId) return accountId;
	const fromRefresh = refreshToken
		? await resolveGitHubUsername(ctx, baseUrl, refreshToken, params.signal)
		: accountId;
	if (fromRefresh || !accessToken) return fromRefresh;
	return resolveGitHubUsername(ctx, baseUrl, accessToken, params.signal);
}

/** An OAuth credential reads the Copilot quota with its GitHub token: the refresh token when set, else the access token. */
async function fetchOAuthUsage(
	params: UsageFetchParams,
	ctx: UsageFetchContext,
	baseUrl: string,
): Promise<UsageReport | null> {
	const { refreshToken, accessToken, email } = params.credential;
	const githubToken = refreshToken ?? accessToken;
	if (!githubToken) return null;
	return readUsageReport(ctx, async () => {
		const usage = await fetchInternalUsage(ctx, baseUrl, githubToken, params.signal);
		const accountId = await resolveOAuthAccountId(params, ctx, baseUrl);
		return buildQuotaReport(usage, accountId, { accountId, email });
	});
}

export const githubCopilotUsageProvider: UsageProvider = {
	id: "github-copilot",
	supports: ({ provider, credential }) => {
		if (provider !== "github-copilot") return false;
		if (credential.type === "oauth") {
			return Boolean(credential.refreshToken || credential.accessToken);
		}
		return Boolean(credential.apiKey);
	},
	fetchUsage: async (params, ctx) => {
		if (!githubCopilotUsageProvider.supports?.(params)) return null;
		const githubApiBaseUrl = resolveGitHubApiBaseUrl(params);
		const { credential } = params;
		if (credential.type === "oauth") return fetchOAuthUsage(params, ctx, githubApiBaseUrl);
		return credential.apiKey ? fetchApiKeyUsage(params, ctx, githubApiBaseUrl, credential.apiKey) : null;
	},
};
