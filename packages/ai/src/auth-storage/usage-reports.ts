/**
 * Usage reports: the account and project a report is scoped to, merging the reports one account
 * produced, and reading exhausted windows and reset times out of a report's limits.
 */

import type { CredentialRankingContext, CredentialRankingStrategy, UsageLimit, UsageReport } from "../usage";

export function getUsageReportMetadataValue(report: UsageReport, key: string): string | undefined {
	const metadata = report.metadata;
	if (!metadata || typeof metadata !== "object") return undefined;
	const value = metadata[key];
	return typeof value === "string" ? value.trim() : undefined;
}

/** The one non-blank `key` every limit scope in `report` agrees on, else undefined. */
function uniqueUsageReportScope(report: UsageReport, key: "accountId" | "projectId"): string | undefined {
	const ids = new Set<string>();
	for (const limit of report.limits) {
		const id = limit.scope[key]?.trim();
		if (id) ids.add(id);
	}
	if (ids.size === 1) return [...ids][0];
	return undefined;
}

export function getUsageReportScopeAccountId(report: UsageReport): string | undefined {
	return uniqueUsageReportScope(report, "accountId");
}

function getUsageReportScopeProjectId(report: UsageReport): string | undefined {
	return uniqueUsageReportScope(report, "projectId");
}

export function getUsageReportIdentifiers(report: UsageReport): string[] {
	const identifiers: string[] = [];
	const email = getUsageReportMetadataValue(report, "email");
	if (email) identifiers.push(`email:${email.toLowerCase()}`);
	if (report.provider === "anthropic") {
		// Anthropic: one account email can hold several organizations
		// (Team seat + personal Max). Reports from different orgs must not
		// merge — scope every identifier by org when the report carries one.
		// When the email could not be recovered, fall back to the account
		// (identical across orgs, hence the org qualifier is what keeps two
		// subscriptions apart) so no-email reports still merge per org.
		// Org-less reports (pre-upgrade caches) keep their bare identifiers
		// and only merge among themselves.
		if (identifiers.length === 0) {
			const accountId = getUsageReportMetadataValue(report, "accountId") ?? getUsageReportScopeAccountId(report);
			if (accountId) identifiers.push(`account:${accountId}`);
		}
		const orgId = getUsageReportMetadataValue(report, "orgId");
		if (orgId) {
			if (identifiers.length === 0) return [`anthropic:org:${orgId.toLowerCase()}`];
			return identifiers.map(identifier => `anthropic:org:${orgId.toLowerCase()}|${identifier.toLowerCase()}`);
		}
		return identifiers.map(identifier => `anthropic:${identifier.toLowerCase()}`);
	}
	if (report.provider === "openai-codex") {
		return identifiers.map(identifier => `${report.provider}:${identifier.toLowerCase()}`);
	}
	const projectId = getUsageReportMetadataValue(report, "projectId") ?? getUsageReportScopeProjectId(report);
	// Only add project as a fallback when no email is available — two users
	// with different emails on the same GCP project must not merge.
	if (projectId && !email) identifiers.push(`project:${projectId}`);
	const accountId = getUsageReportMetadataValue(report, "accountId");
	if (accountId) identifiers.push(`account:${accountId}`);
	const account = getUsageReportMetadataValue(report, "account");
	if (account) identifiers.push(`account:${account}`);
	const user = getUsageReportMetadataValue(report, "user");
	if (user) identifiers.push(`account:${user}`);
	const username = getUsageReportMetadataValue(report, "username");
	if (username) identifiers.push(`account:${username}`);
	const scopeAccountId = getUsageReportScopeAccountId(report);
	if (scopeAccountId) identifiers.push(`account:${scopeAccountId}`);
	return identifiers.map(identifier => `${report.provider}:${identifier.toLowerCase()}`);
}

export function mergeUsageReportGroup(reports: UsageReport[]): UsageReport {
	if (reports.length === 1) return reports[0];
	const sorted = [...reports].sort((a, b) => {
		const limitDiff = b.limits.length - a.limits.length;
		if (limitDiff !== 0) return limitDiff;
		return (b.fetchedAt ?? 0) - (a.fetchedAt ?? 0);
	});
	const base = sorted[0];
	const mergedLimits = [...base.limits];
	const limitIds = new Set(mergedLimits.map(limit => limit.id));
	const mergedMetadata: Record<string, unknown> = { ...(base.metadata ?? {}) };
	let fetchedAt = base.fetchedAt;

	for (const report of sorted.slice(1)) {
		fetchedAt = Math.max(fetchedAt, report.fetchedAt);
		for (const limit of report.limits) {
			if (!limitIds.has(limit.id)) {
				limitIds.add(limit.id);
				mergedLimits.push(limit);
			}
		}
		if (report.metadata) {
			for (const [key, value] of Object.entries(report.metadata)) {
				if (mergedMetadata[key] === undefined) {
					mergedMetadata[key] = value;
				}
			}
		}
	}

	return {
		...base,
		fetchedAt,
		limits: mergedLimits,
		metadata: Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined,
	};
}

export function isUsageLimitExhausted(limit: UsageLimit): boolean {
	if (limit.status === "exhausted") return true;
	const amount = limit.amount;
	if (amount.usedFraction !== undefined && amount.usedFraction >= 1) return true;
	if (amount.remainingFraction !== undefined && amount.remainingFraction <= 0) return true;
	if (amount.used !== undefined && amount.limit !== undefined && amount.used >= amount.limit) return true;
	if (amount.remaining !== undefined && amount.remaining <= 0) return true;
	if (amount.unit === "percent" && amount.used !== undefined && amount.used >= 100) return true;
	return false;
}

/** Return the usage limits that apply to the requested model for this strategy. */
export function getScopedUsageLimits(
	strategy: CredentialRankingStrategy,
	report: UsageReport,
	context: CredentialRankingContext,
): UsageLimit[] {
	return strategy.scopeLimits?.(report, context) ?? report.limits;
}

/** Returns true if usage indicates rate limit has been reached. */
export function isUsageLimitReached(limits: UsageLimit[]): boolean {
	return limits.some(limit => isUsageLimitExhausted(limit));
}

/** Extracts the earliest reset timestamp from exhausted windows (in ms). */
export function getUsageResetAtMs(limits: UsageLimit[], nowMs: number): number | undefined {
	const candidates: number[] = [];
	for (const limit of limits) {
		if (!isUsageLimitExhausted(limit)) continue;
		const window = limit.window;
		if (window?.resetsAt && window.resetsAt > nowMs) {
			candidates.push(window.resetsAt);
		}
	}
	if (candidates.length === 0) return undefined;
	return Math.min(...candidates);
}

/**
 * Self-heal a stale Codex usage-limit block: when a fresh live usage report
 * says the account is allowed and below every reported limit, drop the
 * persisted and in-memory `openai-codex:oauth` blocks so credential selection
 * can re-include recovered seats before a stale block naturally expires.
 */
export function isHealthyCodexUsageReport(report: UsageReport): boolean {
	if (report.provider !== "openai-codex") return false;
	const metadata = report.metadata;
	if (metadata?.allowed !== true || metadata.limitReached !== false) return false;
	return !isUsageLimitReached(report.limits);
}
