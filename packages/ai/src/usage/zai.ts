import { toNumber } from "@veyyon/catalog/utils";
import { formatCount } from "@veyyon/utils/format";
import { clamp01 } from "@veyyon/utils/math";
import { DAY_MS, HOUR_MS, WEEK_MS } from "@veyyon/utils/time";
import type { Provider } from "../types";
import type {
	CredentialRankingStrategy,
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageWindow,
} from "../usage";
import { isRecord } from "../utils";
import { usageStatusFromUsedFraction } from "./shared";

const DEFAULT_ENDPOINT = "https://api.z.ai";
const QUOTA_PATH = "/api/monitor/usage/quota/limit";
const MODEL_USAGE_PATH = "/api/monitor/usage/model-usage";
const MONTH_MS = 30 * DAY_MS;

interface ZaiUsageDetail {
	modelCode?: string;
	usage?: number;
}

function normalizeZaiBaseUrl(baseUrl?: string): string {
	if (!baseUrl?.trim()) return DEFAULT_ENDPOINT;
	try {
		return new URL(baseUrl.trim()).origin;
	} catch {
		return DEFAULT_ENDPOINT;
	}
}

interface ZaiUsageLimitItem {
	type?: string;
	usage?: number;
	currentValue?: number;
	percentage?: number;
	remaining?: number;
	nextResetTime?: number;
	unit?: number;
	number?: number;
	usageDetails?: ZaiUsageDetail[];
}

interface ZaiQuotaPayload {
	success?: boolean;
	code?: number;
	msg?: string;
	data?: {
		limits?: ZaiUsageLimitItem[];
	};
}

function parseMillis(value: unknown): number | undefined {
	const parsed = toNumber(value);
	if (parsed === undefined) return undefined;
	return parsed > 1_000_000_000_000 ? parsed : parsed * 1000;
}

function parseUsageDetails(value: unknown): ZaiUsageDetail[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const details: ZaiUsageDetail[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		const modelCode = typeof item.modelCode === "string" && item.modelCode ? item.modelCode : undefined;
		const usage = toNumber(item.usage);
		details.push({
			...(modelCode !== undefined ? { modelCode } : {}),
			...(usage !== undefined ? { usage } : {}),
		});
	}
	return details.length > 0 ? details : undefined;
}

function parseLimitItem(value: unknown): ZaiUsageLimitItem | null {
	if (!isRecord(value)) return null;
	const type = typeof value.type === "string" ? value.type : undefined;
	if (!type) return null;
	return {
		type,
		usage: toNumber(value.usage),
		currentValue: toNumber(value.currentValue),
		percentage: toNumber(value.percentage),
		remaining: toNumber(value.remaining),
		nextResetTime: parseMillis(value.nextResetTime),
		unit: toNumber(value.unit),
		number: toNumber(value.number),
		usageDetails: parseUsageDetails(value.usageDetails),
	};
}

function buildUsageAmount(parsed: ZaiUsageLimitItem, unit: UsageAmount["unit"]): UsageAmount {
	const { currentValue: used, usage: limit, remaining, percentage } = parsed;
	const usedFraction =
		percentage !== undefined
			? clamp01(percentage / 100)
			: used !== undefined && limit !== undefined && limit > 0
				? Math.min(used / limit, 1)
				: undefined;
	const remainingFraction = usedFraction !== undefined ? Math.max(1 - usedFraction, 0) : undefined;
	return { used, limit, remaining, usedFraction, remainingFraction, unit };
}

// Z.ai omits the status field when the used fraction is unknown (rather than
// emitting "unknown"), so the undefined case stays here; the defined-fraction
// ladder is the shared owner.
function getUsageStatus(usedFraction: number | undefined): UsageStatus | undefined {
	return usedFraction === undefined ? undefined : usageStatusFromUsedFraction(usedFraction);
}

function formatDate(value: Date): string {
	const pad = (input: number) => String(input).padStart(2, "0");
	return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}+${pad(value.getHours())}:${pad(
		value.getMinutes(),
	)}:${pad(value.getSeconds())}`;
}

function buildZaiWindow(parsed: ZaiUsageLimitItem): UsageWindow {
	const count = parsed.number !== undefined && parsed.number > 0 ? parsed.number : 1;
	let id: string;
	let label: string;
	let durationMs: number | undefined;
	switch (parsed.unit) {
		case 3:
			id = `${count}h`;
			label = formatCount("Hour", count);
			durationMs = count * HOUR_MS;
			break;
		case 4:
			id = `${count}d`;
			label = formatCount("Day", count);
			durationMs = count * DAY_MS;
			break;
		case 5:
			id = `${count}mo`;
			label = count === 1 ? "Monthly" : formatCount("Month", count);
			durationMs = count * MONTH_MS;
			break;
		case 6:
			id = "1w";
			label = "Weekly";
			durationMs = WEEK_MS;
			break;
		default:
			id = parsed.unit !== undefined ? `${count}u${parsed.unit}` : "quota";
			label = "Quota";
			break;
	}
	return {
		id,
		label,
		...(durationMs !== undefined ? { durationMs } : {}),
		...(parsed.nextResetTime !== undefined ? { resetsAt: parsed.nextResetTime } : {}),
	};
}

function isZaiFeatureRequestLimit(parsed: ZaiUsageLimitItem): boolean {
	if (!parsed.usageDetails) return false;
	const codes = new Set(parsed.usageDetails.map(detail => detail.modelCode));
	return codes.has("search-prime") && codes.has("web-reader") && codes.has("zread");
}

function zaiTokenLimit(parsed: ZaiUsageLimitItem, provider: Provider): UsageLimit {
	const amount = buildUsageAmount(parsed, "tokens");
	const window = buildZaiWindow(parsed);
	return {
		id: `zai:tokens:${window.id}`,
		label: `ZAI ${window.label} Token Quota`,
		scope: { provider, windowId: window.id, shared: true },
		window,
		amount,
		status: getUsageStatus(amount.usedFraction),
	};
}

function zaiRequestLimit(parsed: ZaiUsageLimitItem, provider: Provider): UsageLimit {
	const window = buildZaiWindow(parsed);
	const amount = buildUsageAmount(parsed, "requests");
	if (isZaiFeatureRequestLimit(parsed)) {
		return {
			id: `zai:features:web-search-reader-zread:${window.id}`,
			label: "ZAI Web Search / Reader / Zread Quota",
			scope: { provider, windowId: window.id, shared: false, tier: "web-search-reader-zread" },
			window,
			amount,
			status: getUsageStatus(amount.usedFraction),
		};
	}
	return {
		id: `zai:requests:${window.id}`,
		label: "ZAI Request Quota",
		scope: { provider, windowId: window.id, shared: true },
		window,
		amount,
		status: getUsageStatus(amount.usedFraction),
	};
}

function buildModelUsageUrl(baseUrl: string, now: Date): string {
	const start = new Date(now.getTime() - WEEK_MS);
	const startTime = formatDate(start);
	const endTime = formatDate(now);
	return `${baseUrl}${MODEL_USAGE_PATH}?startTime=${encodeURIComponent(startTime)}&endTime=${encodeURIComponent(endTime)}`;
}

function getZaiCredentialLimits(report: UsageReport): UsageLimit[] {
	const limits = report.limits.filter(
		limit => limit.id.startsWith("zai:requests:") || limit.id.startsWith("zai:tokens:"),
	);
	return limits;
}

function rankZaiRequestLimits(report: UsageReport): UsageLimit[] {
	const requestLimits = report.limits.filter(limit => limit.id.startsWith("zai:requests:"));
	const credentialLimits = getZaiCredentialLimits(report);
	const limits = requestLimits.length > 0 ? requestLimits : credentialLimits;
	const ranked = limits.slice();
	ranked.sort((left, right) => {
		const leftDuration = left.window?.durationMs ?? Number.POSITIVE_INFINITY;
		const rightDuration = right.window?.durationMs ?? Number.POSITIVE_INFINITY;
		if (leftDuration !== rightDuration) return leftDuration - rightDuration;
		const leftReset = left.window?.resetsAt ?? Number.POSITIVE_INFINITY;
		const rightReset = right.window?.resetsAt ?? Number.POSITIVE_INFINITY;
		return leftReset - rightReset;
	});
	return ranked;
}

async function fetchZaiQuota(
	url: string,
	headers: Record<string, string>,
	params: UsageFetchParams,
	ctx: UsageFetchContext,
): Promise<ZaiQuotaPayload | null> {
	let payload: ZaiQuotaPayload | null;
	try {
		const response = await ctx.fetch(url, { headers, signal: params.signal });
		if (!response.ok) {
			ctx.logger?.warn("ZAI usage fetch failed", { status: response.status, statusText: response.statusText });
			return null;
		}
		payload = (await response.json()) as ZaiQuotaPayload;
	} catch (error) {
		ctx.logger?.warn("ZAI usage fetch error", { error: String(error) });
		return null;
	}
	if (payload && payload.success !== true) {
		ctx.logger?.warn("ZAI usage response invalid", { code: payload.code, message: payload.msg });
		return null;
	}
	return payload;
}

// The per-model breakdown is optional metadata: any failure leaves the report without it.
async function fetchZaiModelUsage(
	baseUrl: string,
	headers: Record<string, string>,
	params: UsageFetchParams,
	ctx: UsageFetchContext,
): Promise<Record<string, unknown> | undefined> {
	try {
		const response = await ctx.fetch(buildModelUsageUrl(baseUrl, new Date()), { headers, signal: params.signal });
		if (!response.ok) return undefined;
		const payload = (await response.json()) as unknown;
		return isRecord(payload) ? payload : undefined;
	} catch (error) {
		ctx.logger?.debug("ZAI model usage fetch failed", { error: String(error) });
		return undefined;
	}
}

async function fetchZaiUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== "zai") return null;
	const credential = params.credential;
	if (credential.type !== "api_key" || !credential.apiKey) return null;

	const baseUrl = normalizeZaiBaseUrl(params.baseUrl);
	const url = `${baseUrl}${QUOTA_PATH}`;
	const headers: Record<string, string> = {
		Authorization: credential.apiKey,
		"Content-Type": "application/json",
		"User-Agent": "OpenCode-Status-Plugin/1.0",
	};

	const payload = await fetchZaiQuota(url, headers, params, ctx);
	if (!payload) return null;

	const limits: UsageLimit[] = [];
	for (const rawLimit of Array.isArray(payload.data?.limits) ? payload.data.limits : []) {
		const parsed = parseLimitItem(rawLimit);
		if (parsed?.type === "TOKENS_LIMIT") limits.push(zaiTokenLimit(parsed, params.provider));
		else if (parsed?.type === "TIME_LIMIT") limits.push(zaiRequestLimit(parsed, params.provider));
	}
	if (limits.length === 0) return null;

	const fetchedAt = Date.now();
	const modelUsage = await fetchZaiModelUsage(baseUrl, headers, params, ctx);
	return {
		provider: params.provider,
		fetchedAt,
		limits,
		metadata: {
			endpoint: url,
			accountId: credential.accountId,
			email: credential.email,
			...(modelUsage ? { modelUsage } : {}),
		},
		raw: payload,
	};
}

export const zaiUsageProvider: UsageProvider = {
	id: "zai",
	fetchUsage: fetchZaiUsage,
	supports: params => params.provider === "zai" && params.credential.type === "api_key",
};

export const zaiRankingStrategy: CredentialRankingStrategy = {
	findWindowLimits(report) {
		const ranked = rankZaiRequestLimits(report);
		return { primary: ranked[0], secondary: ranked[1] };
	},
	scopeLimits(report) {
		const limits = getZaiCredentialLimits(report);
		return limits;
	},
	windowDefaults: {
		primaryMs: 5 * HOUR_MS,
		secondaryMs: WEEK_MS,
	},
};
