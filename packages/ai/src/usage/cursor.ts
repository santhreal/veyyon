import { CURSOR_API_ENDPOINT } from "@veyyon/catalog/provider-endpoints";
import { toNumber } from "@veyyon/catalog/utils";
import { isRecord } from "@veyyon/utils/type-guards";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import type {
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageWindow,
} from "../usage";
import { usageStatusFromUsedFraction } from "./shared";

function parseTimestamp(value: unknown): number | undefined {
	const numeric = toNumber(value);
	if (numeric !== undefined) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeCursorBaseUrl(baseUrl?: string): string {
	if (!baseUrl) return CURSOR_API_ENDPOINT;
	return trimTrailingSlashes(baseUrl);
}

function deriveResetsAt(payload: Record<string, unknown>): number | undefined {
	const endKeys = ["billingCycleEnd", "endOfMonth", "resetsAt", "nextReset"];
	for (const key of endKeys) {
		const parsed = parseTimestamp(payload[key]);
		if (parsed !== undefined) return parsed;
	}

	const startKeys = ["startOfMonth", "billingCycleStart", "startOfBillingCycle"];
	for (const key of startKeys) {
		const parsed = parseTimestamp(payload[key]);
		if (parsed !== undefined) {
			const date = new Date(parsed);
			date.setUTCMonth(date.getUTCMonth() + 1);
			return date.getTime();
		}
	}
	return undefined;
}

const CURSOR_USED_KEYS = ["numRequests", "used", "amountUsed", "usdUsed"];
const CURSOR_LIMIT_KEYS = ["maxRequestUsage", "limit", "amountLimit", "usdLimit"];

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
	for (const key of keys) {
		const value = toNumber(record[key]);
		if (value !== undefined) return value;
	}
	return undefined;
}

/** Plan and billing buckets count dollars; every other bucket counts requests. */
function isCursorUsdBucket(key: string): boolean {
	if (key === "planUsage") return true;
	const lower = key.toLowerCase();
	return lower.includes("usd") || lower.includes("billing") || lower.includes("stripe");
}

function buildCursorLimit(key: string, used: number, limit: number, window: UsageWindow): UsageLimit {
	const isUsd = isCursorUsdBucket(key);
	const remaining = Math.max(0, limit - used);
	const usedFraction = limit > 0 ? used / limit : 0;
	return {
		id: `cursor:${isUsd ? "usd" : "requests"}:${key.toLowerCase().trim()}`,
		label: isUsd ? `${key} spend` : `${key} requests`,
		scope: { provider: "cursor", windowId: window.id },
		window,
		amount: {
			used,
			limit,
			remaining,
			usedFraction,
			remainingFraction: limit > 0 ? remaining / limit : 0,
			unit: isUsd ? "usd" : "requests",
		},
		status: usageStatusFromUsedFraction(usedFraction),
	};
}

export function parseCursorUsage(payload: unknown, fetchedAt = Date.now()): UsageReport | null {
	if (!isRecord(payload)) return null;
	const resetsAt = deriveResetsAt(payload);
	const window: UsageWindow = {
		id: "monthly",
		label: "Monthly",
		...(resetsAt !== undefined ? { resetsAt } : {}),
	};

	const limits: UsageLimit[] = [];
	for (const [key, value] of Object.entries(payload)) {
		if (!isRecord(value)) continue;
		const used = firstNumber(value, CURSOR_USED_KEYS);
		const limit = firstNumber(value, CURSOR_LIMIT_KEYS);
		if (used !== undefined && limit !== undefined) limits.push(buildCursorLimit(key, used, limit, window));
	}
	if (limits.length === 0) return null;

	return {
		provider: "cursor",
		fetchedAt,
		limits,
		raw: payload,
	};
}

export const cursorUsageProvider: UsageProvider = {
	id: "cursor",
	supports(params: UsageFetchParams): boolean {
		if (params.provider !== "cursor") return false;
		const { credential } = params;
		if (credential.type === "oauth") {
			return Boolean(credential.accessToken);
		}
		if (credential.type === "api_key") {
			return Boolean(credential.apiKey);
		}
		return false;
	},
	async fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
		if (params.provider !== "cursor") return null;
		const { credential } = params;
		const token = credential.type === "oauth" ? credential.accessToken : credential.apiKey;
		if (!token) return null;

		const baseUrl = normalizeCursorBaseUrl(params.baseUrl ?? credential.apiEndpoint);
		const url = `${baseUrl}/auth/usage`;

		const headers: Record<string, string> = {
			Accept: "application/json",
			Authorization: `Bearer ${token}`,
		};

		try {
			const response = await ctx.fetch(url, {
				headers,
				signal: params.signal,
			});
			if (!response.ok) {
				ctx.logger?.warn("Cursor usage request failed", {
					status: response.status,
					provider: params.provider,
				});
				return null;
			}
			const payload = await response.json();
			const report = parseCursorUsage(payload);
			if (report) {
				const metadata = {
					...(credential.email ? { email: credential.email } : {}),
					...(credential.accountId ? { accountId: credential.accountId } : {}),
					...(credential.projectId ? { projectId: credential.projectId } : {}),
				};
				if (Object.keys(metadata).length > 0) report.metadata = metadata;
			}
			return report;
		} catch (error) {
			ctx.logger?.warn("Cursor usage request error", {
				provider: params.provider,
				error: String(error),
			});
			return null;
		}
	},
};
