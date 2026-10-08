// (Refresh is the sole responsibility of AuthStorage; no provider-direct refresh here.)
import { toNumber } from "@veyyon/catalog/utils";
import { $env } from "@veyyon/utils/env";
import { clamp01 } from "@veyyon/utils/math";
import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS } from "@veyyon/utils/time";
import { normalizeBaseUrl } from "@veyyon/utils/url";
import { getKimiCommonHeaders } from "../registry/oauth/kimi";
import type {
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageWindow,
} from "../usage";
import { isRecord } from "../utils";
import { usageStatusFromUsedFraction } from "./shared";

const DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
const USAGE_PATH = "usages";

interface KimiUsagePayload {
	usage?: unknown;
	limits?: unknown;
}

type KimiUsageRow = {
	label: string;
	used?: number;
	limit?: number;
	remaining?: number;
	resetsAt?: number;
	window?: UsageWindow;
};

// Kimi's own env/default resolution: prefer the explicit arg, then the
// KIMI_CODE_BASE_URL override, then the built-in default. Slash/whitespace
// normalization is delegated to the shared @veyyon/utils owner.
function resolveKimiBaseUrl(baseUrl?: string): string {
	const candidate = baseUrl?.trim() || $env.KIMI_CODE_BASE_URL?.trim() || DEFAULT_BASE_URL;
	return normalizeBaseUrl(candidate, DEFAULT_BASE_URL);
}

function buildUsageUrl(baseUrl: string): string {
	const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	return `${normalized}${USAGE_PATH}`;
}

interface KimiTimeUnit {
	readonly name: string;
	readonly ms: number;
	readonly suffix: string;
}

// Matched by substring; the first unit whose name the time unit contains wins.
const KIMI_TIME_UNITS: readonly KimiTimeUnit[] = [
	{ name: "MINUTE", ms: MINUTE_MS, suffix: "m" },
	{ name: "HOUR", ms: HOUR_MS, suffix: "h" },
	{ name: "DAY", ms: DAY_MS, suffix: "d" },
	{ name: "SECOND", ms: SECOND_MS, suffix: "s" },
];

const RESET_AT_KEYS = ["reset_at", "resetAt", "reset_time", "resetTime"] as const;
const RESET_IN_SECONDS_KEYS = ["reset_in", "resetIn", "ttl", "window"] as const;

function findTimeUnit(timeUnit: string): KimiTimeUnit | undefined {
	const upper = timeUnit.toUpperCase();
	return KIMI_TIME_UNITS.find(unit => upper.includes(unit.name));
}

function firstNonEmptyString(candidates: readonly unknown[]): string | undefined {
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate) return candidate;
	}
	return undefined;
}

// A date string, epoch milliseconds, or epoch seconds (anything at or below 10^12).
function parseTimestamp(value: unknown): number | undefined {
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return undefined;
		return value > 1_000_000_000_000 ? value : value * 1000;
	}
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseResetTime(data: Record<string, unknown>, nowMs: number): number | undefined {
	for (const key of RESET_AT_KEYS) {
		const resetsAt = parseTimestamp(data[key]);
		if (resetsAt !== undefined) return resetsAt;
	}
	for (const key of RESET_IN_SECONDS_KEYS) {
		const seconds = toNumber(data[key]);
		if (seconds !== undefined) return nowMs + seconds * 1000;
	}
	return undefined;
}

function formatDurationLabel(duration: number, unit: KimiTimeUnit | undefined): string | undefined {
	if (!unit) return undefined;
	if (unit.ms === MINUTE_MS && duration >= 60 && duration % 60 === 0) return `${duration / 60}h limit`;
	return `${duration}${unit.suffix} limit`;
}

function buildWindow(windowData: Record<string, unknown>, nowMs: number): UsageWindow | undefined {
	const duration = toNumber(windowData.duration);
	const resetsAt = parseResetTime(windowData, nowMs);
	if (duration === undefined) {
		return resetsAt ? { id: "default", label: "Usage window", durationMs: undefined, resetsAt } : undefined;
	}
	const timeUnit = typeof windowData.timeUnit === "string" ? windowData.timeUnit : "";
	const unit = findTimeUnit(timeUnit);
	return {
		id: timeUnit ? `${duration}${timeUnit.toLowerCase()}` : "default",
		label: formatDurationLabel(duration, unit) ?? "Usage window",
		durationMs: unit ? duration * unit.ms : undefined,
		resetsAt,
	};
}

function buildUsageRow(data: Record<string, unknown>, defaultLabel: string, nowMs: number): KimiUsageRow | null {
	const limit = toNumber(data.limit);
	let used = toNumber(data.used);
	const remaining = toNumber(data.remaining);
	if (used === undefined && remaining !== undefined && limit !== undefined) {
		used = limit - remaining;
	}

	if (used === undefined && limit === undefined) return null;
	const resetsAt = parseResetTime(data, nowMs);
	return {
		label: firstNonEmptyString([data.name, data.title]) ?? defaultLabel,
		used,
		limit,
		remaining,
		resetsAt,
	};
}

function buildUsageAmount(row: KimiUsageRow): UsageAmount {
	const amount: UsageAmount = { unit: "unknown" };
	if (row.limit !== undefined) amount.limit = row.limit;
	if (row.used !== undefined) amount.used = row.used;
	if (row.remaining !== undefined) amount.remaining = row.remaining;
	if (row.limit !== undefined && row.used !== undefined && row.limit > 0) {
		amount.usedFraction = clamp01(row.used / row.limit);
		amount.remainingFraction = clamp01((row.limit - row.used) / row.limit);
		amount.remaining = amount.remaining ?? row.limit - row.used;
	}
	return amount;
}

function toUsageLimit(row: KimiUsageRow, provider: string, index: number, accountId?: string): UsageLimit {
	const window: UsageWindow | undefined =
		row.window ??
		(row.resetsAt
			? {
					id: "default",
					label: "Usage window",
					resetsAt: row.resetsAt,
				}
			: undefined);

	const amount = buildUsageAmount(row);
	return {
		id: `${provider}:${index}`,
		label: row.label,
		scope: {
			provider,
			accountId,
			windowId: window?.id,
			shared: true,
		},
		window,
		amount,
		status: usageStatusFromUsedFraction(amount.usedFraction),
	};
}

function buildLimitRow(item: unknown, index: number, nowMs: number): KimiUsageRow | null {
	if (!isRecord(item)) return null;
	const detail = isRecord(item.detail) ? item.detail : item;
	const windowData = isRecord(item.window) ? item.window : {};
	const label =
		firstNonEmptyString([item.name, item.title, item.scope, detail.name, detail.title]) ??
		formatDurationLabel(toNumber(windowData.duration) ?? 0, findTimeUnit(String(windowData.timeUnit || ""))) ??
		`Limit #${index + 1}`;
	const row = buildUsageRow(detail, label, nowMs);
	if (row) row.window = buildWindow(windowData, nowMs);
	return row;
}

function parseUsagePayload(payload: unknown, nowMs: number): { rows: KimiUsageRow[]; raw: KimiUsagePayload } | null {
	if (!isRecord(payload)) return null;
	const data = payload as KimiUsagePayload;
	const rows: KimiUsageRow[] = [];

	if (isRecord(data.usage)) {
		const summary = buildUsageRow(data.usage, "Total quota", nowMs);
		if (summary) rows.push(summary);
	}

	if (Array.isArray(data.limits)) {
		for (let index = 0; index < data.limits.length; index++) {
			const row = buildLimitRow(data.limits[index], index, nowMs);
			if (row) rows.push(row);
		}
	}

	return { rows, raw: data };
}

export const kimiUsageProvider: UsageProvider = {
	id: "kimi-code",
	supports(params: UsageFetchParams): boolean {
		return params.provider === "kimi-code" && params.credential.type === "oauth";
	},
	async fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
		if (params.provider !== "kimi-code") return null;
		const { credential } = params;
		if (credential.type !== "oauth") return null;

		const accessToken = credential.accessToken;
		if (!accessToken) return null;

		const nowMs = Date.now();
		// AuthStorage refreshes OAuth credentials pre-emptively (60s skew). If the
		// usage probe lands with an expired token, short-circuit rather than POST
		// the broker sentinel back to Kimi — the next cycle will carry a freshly
		// refreshed credential.
		if (credential.expiresAt !== undefined && credential.expiresAt <= nowMs) {
			ctx.logger?.debug("Kimi usage token expired; skipping probe", { provider: params.provider });
			return null;
		}

		const baseUrl = resolveKimiBaseUrl(params.baseUrl);
		const url = buildUsageUrl(baseUrl);
		// Build the request headers OUTSIDE the network try. Header construction
		// is deterministic and non-network; if it ever fails it is a real local
		// error (a filesystem or config fault), not a "usage unavailable" signal.
		// Keeping it inside the try would swallow such an error as a silent null
		// (Law 10) — the exact failure mode that once masked getDeviceId's
		// ENOENT on a fresh host. Let it surface.
		const commonHeaders = getKimiCommonHeaders();
		let payload: unknown;
		try {
			const response = await ctx.fetch(url, {
				headers: {
					...commonHeaders,
					Authorization: `Bearer ${accessToken}`,
				},
				signal: params.signal,
			});
			if (!response.ok) {
				ctx.logger?.warn("Kimi usage request failed", { status: response.status, provider: params.provider });
				return null;
			}
			payload = await response.json();
		} catch (error) {
			ctx.logger?.warn("Kimi usage request error", { provider: params.provider, error: String(error) });
			return null;
		}

		const parsed = parseUsagePayload(payload, nowMs);
		if (!parsed || parsed.rows.length === 0) {
			ctx.logger?.warn("Kimi usage response invalid", { provider: params.provider });
			return null;
		}

		const limits = parsed.rows.map((row, index) => toUsageLimit(row, params.provider, index, credential.accountId));

		const report: UsageReport = {
			provider: params.provider,
			fetchedAt: nowMs,
			limits,
			metadata: {
				endpoint: url,
			},
			raw: parsed.raw,
		};

		return report;
	},
};
