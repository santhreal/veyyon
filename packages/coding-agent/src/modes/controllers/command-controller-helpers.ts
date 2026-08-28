import { getEnvApiKey, type ProviderDetails, type UsageLimit, type UsageReport } from "@veyyon/ai";
import { resolveUsedFraction } from "@veyyon/ai/usage";
import { padding, subCellBar, visibleWidth } from "@veyyon/tui";
import { clamp01, formatDuration, sanitizeText } from "@veyyon/utils";
import { theme } from "../../modes/theme/theme";
import type { AsyncJobSnapshotItem } from "../../session/agent-session";
import type { AuthStorage, OAuthAccountIdentity } from "../../session/auth-storage";
import { limitMatchesActiveAccount } from "../../slash-commands/helpers/active-oauth-account";
import { formatProviderName } from "../../slash-commands/helpers/format";
import { replaceTabs, truncateToWidth } from "../../tools/render-utils";

export const BAR_WIDTH_MAX = 24;
export const BAR_WIDTH_MIN = 4;

export function renderJobLine(job: AsyncJobSnapshotItem, now: number): string {
	const duration = formatDuration(Math.max(0, now - job.startTime));
	const status = formatJobStatus(job.status);
	return `${theme.fg("dim", job.id)} ${theme.fg("dim", `[${job.type}]`)} ${status} ${theme.fg("dim", `(${duration})`)}`;
}

export function formatJobStatus(status: AsyncJobSnapshotItem["status"]): string {
	if (status === "running") return theme.fg("warning", "running");
	if (status === "completed") return theme.fg("success", "completed");
	if (status === "cancelled") return theme.fg("dim", "cancelled");
	return theme.fg("error", "failed");
}

export function formatDecimal(value: number, maxFractionDigits = 1): string {
	return new Intl.NumberFormat("en-US", { maximumFractionDigits: maxFractionDigits }).format(value);
}

export function resolveProviderAuthMode(authStorage: AuthStorage, provider: string): string {
	if (authStorage.hasOAuth(provider)) {
		return "oauth";
	}
	if (authStorage.has(provider)) {
		return "api key";
	}
	if (getEnvApiKey(provider)) {
		return "env api key";
	}
	if (authStorage.hasAuth(provider)) {
		return "runtime/fallback";
	}
	return "unknown";
}

export function renderProviderSection(details: ProviderDetails, uiTheme: Pick<typeof theme, "fg">): string {
	const lines: string[] = [];
	lines.push(`${uiTheme.fg("dim", "Name:")} ${details.provider}`);
	for (const field of details.fields) {
		lines.push(`${uiTheme.fg("dim", `${field.label}:`)} ${field.value}`);
	}
	return `${lines.join("\n")}\n`;
}

export function resolveProviderUsageTotal(reports: UsageReport[]): number {
	let total = 0;
	for (let ri = 0; ri < reports.length; ri++) {
		const limits = reports[ri]!.limits;
		for (let li = 0; li < limits.length; li++) {
			total += resolveUsedFraction(limits[li]!) ?? 0;
		}
	}
	return total;
}

export function formatLimitTitle(limit: UsageLimit): string {
	const tier = limit.scope.tier;
	if (tier && !limit.label.toLowerCase().includes(tier.toLowerCase())) {
		return `${limit.label} (${tier})`;
	}
	return limit.label;
}

export function formatWindowSuffix(label: string, windowLabel: string, uiTheme: typeof theme): string {
	const normalizedLabel = label.toLowerCase();
	const normalizedWindow = windowLabel.toLowerCase();
	if (normalizedWindow === "quota window") return "";
	if (normalizedLabel.includes(normalizedWindow)) return "";
	return uiTheme.fg("dim", `(${windowLabel})`);
}

export function orgSuffix(report: UsageReport): string {
	const orgName = report.metadata?.orgName;
	const orgId = report.metadata?.orgId;
	const org = typeof orgName === "string" && orgName ? orgName : typeof orgId === "string" ? orgId : undefined;
	return org ? ` (${org})` : "";
}

export function formatAccountLabel(limit: UsageLimit, report: UsageReport, index: number): string {
	const email = report.metadata?.email;
	if (typeof email === "string" && email) return `${email}${orgSuffix(report)}`;
	const accountId =
		typeof report.metadata?.accountId === "string" && report.metadata.accountId
			? report.metadata.accountId
			: limit.scope.accountId || undefined;
	if (accountId) return `${accountId}${orgSuffix(report)}`;
	const projectId =
		typeof report.metadata?.projectId === "string" && report.metadata.projectId
			? report.metadata.projectId
			: limit.scope.projectId || undefined;
	if (projectId) return projectId;
	return `account ${index + 1}`;
}

export function formatUnlimitedReportLabel(report: UsageReport, index: number): string {
	const email = report.metadata?.email;
	if (typeof email === "string" && email) return `${email}${orgSuffix(report)}`;
	const accountId = report.metadata?.accountId;
	if (typeof accountId === "string" && accountId) return `${accountId}${orgSuffix(report)}`;
	const projectId = report.metadata?.projectId;
	if (typeof projectId === "string" && projectId) return projectId;
	return `account ${index + 1}`;
}

export function formatResetShort(limit: UsageLimit, nowMs: number): string | undefined {
	const resetsAt = limit.window?.resetsAt;
	if (resetsAt === undefined) return undefined;
	if (resetsAt <= nowMs) return undefined;
	return formatDuration(resetsAt - nowMs);
}

export function formatAccountHeaderRow(
	limits: UsageLimit[],
	reports: UsageReport[],
	nowMs: number,
	columnWidth: number,
	uiTheme: typeof theme,
	activeAccount?: OAuthAccountIdentity,
): string[] {
	const parts = new Array<{ label: string; suffix: string; active: boolean }>(limits.length);
	for (let li = 0; li < limits.length; li++) {
		const limit = limits[li]!;
		const reset = formatResetShort(limit, nowMs);
		const report = reports[li];
		const active = report !== undefined && limitMatchesActiveAccount(report, limit, activeAccount);
		const label = formatAccountLabel(limit, report, li);
		parts[li] = {
			label: active ? `${theme.status.active} ${label}` : label,
			suffix: reset ? `(${reset})` : "",
			active,
		};
	}
	let maxSuffixWidth = 0;
	for (let pi = 0; pi < parts.length; pi++) {
		const sw = visibleWidth(parts[pi]!.suffix);
		if (sw > maxSuffixWidth) maxSuffixWidth = sw;
	}
	const gap = maxSuffixWidth > 0 ? 1 : 0;
	const prefixBudget = columnWidth - maxSuffixWidth - gap;

	if (prefixBudget < 2) {
		const result = new Array<string>(parts.length);
		for (let pi = 0; pi < parts.length; pi++) {
			const p = parts[pi]!;
			const full = p.suffix ? `${p.label} ${p.suffix}` : p.label;
			const cell = padColumn(truncateToWidth(full, columnWidth), columnWidth);
			result[pi] = p.active ? uiTheme.fg("accent", cell) : cell;
		}
		return result;
	}

	const result = new Array<string>(parts.length);
	for (let pi = 0; pi < parts.length; pi++) {
		const p = parts[pi]!;
		const prefix = truncateToWidth(p.label, prefixBudget);
		const prefixCell = prefix + padding(prefixBudget - visibleWidth(prefix));
		const styledPrefix = p.active ? uiTheme.fg("accent", prefixCell) : prefixCell;
		if (!p.suffix) {
			result[pi] = styledPrefix + padding(maxSuffixWidth + gap);
		} else {
			const suffixPad = padding(maxSuffixWidth - visibleWidth(p.suffix));
			result[pi] = `${styledPrefix} ${suffixPad}${uiTheme.fg("dim", p.suffix)}`;
		}
	}
	return result;
}

export function padColumn(text: string, width: number): string {
	const visible = visibleWidth(text);
	if (visible >= width) return text;
	return `${text}${padding(width - visible)}`;
}

export function resolveAggregateStatus(limits: UsageLimit[]): UsageLimit["status"] {
	let hasOk = false;
	let hasWarning = false;
	let hasExhausted = false;
	for (let li = 0; li < limits.length; li++) {
		const status = limits[li]!.status;
		if (status === "ok") hasOk = true;
		else if (status === "warning") hasWarning = true;
		else if (status === "exhausted") hasExhausted = true;
	}
	if (!hasOk && !hasWarning && !hasExhausted) return "unknown";
	if (hasOk) {
		return hasWarning || hasExhausted ? "warning" : "ok";
	}
	if (hasWarning) return "warning";
	return "exhausted";
}

export function formatAggregateAmount(limits: UsageLimit[]): string {
	let allFractions = true;
	let fractionSum = 0;
	for (let fi = 0; fi < limits.length; fi++) {
		const value = resolveUsedFraction(limits[fi]!);
		if (value === undefined) {
			allFractions = false;
			break;
		}
		fractionSum += value;
	}
	if (allFractions && limits.length > 0) {
		const avgRemaining = Math.max(0, ((limits.length - fractionSum) / limits.length) * 100);
		return `${formatDecimal(avgRemaining)}% free`;
	}

	let allAmounts = true;
	let totalUsed = 0;
	let totalLimit = 0;
	for (let ai = 0; ai < limits.length; ai++) {
		const amount = limits[ai]!.amount;
		if (amount.used === undefined || amount.limit === undefined || amount.limit <= 0) {
			allAmounts = false;
			break;
		}
		totalUsed += amount.used ?? 0;
		totalLimit += amount.limit ?? 0;
	}
	if (allAmounts && limits.length > 0) {
		const remainingPct = totalLimit > 0 ? Math.max(0, 100 - (totalUsed / totalLimit) * 100) : 0;
		return `${formatDecimal(remainingPct)}% free`;
	}

	const uniqueAccountIds = new Set(
		limits.map(limit => limit.scope.accountId).filter((id): id is string => typeof id === "string" && id.length > 0),
	);
	if (uniqueAccountIds.size > 0) return `${uniqueAccountIds.size} ${uniqueAccountIds.size === 1 ? "acct" : "accts"}`;
	return `${limits.length} accts`;
}

export function resolveResetRange(limits: UsageLimit[], nowMs: number): string | null {
	let minReset = Infinity;
	let maxReset = -Infinity;
	for (let ri = 0; ri < limits.length; ri++) {
		const value = limits[ri]!.window?.resetsAt;
		if (value === undefined || !Number.isFinite(value) || value <= nowMs) continue;
		const offset = value - nowMs;
		if (offset < minReset) minReset = offset;
		if (offset > maxReset) maxReset = offset;
	}
	if (minReset === Infinity) return null;
	if (maxReset - minReset > 60_000) {
		return `resets in ${formatDuration(minReset)}–${formatDuration(maxReset)}`;
	}
	return `resets in ${formatDuration(minReset)}`;
}

export function resolveStatusIcon(status: UsageLimit["status"], uiTheme: typeof theme): string {
	if (status === "exhausted") return uiTheme.fg("error", uiTheme.status.error);
	if (status === "warning") return uiTheme.fg("warning", uiTheme.status.warning);
	if (status === "ok") return uiTheme.fg("success", uiTheme.status.success);
	return uiTheme.fg("dim", uiTheme.status.pending);
}

export function resolveStatusColor(status: UsageLimit["status"]): "success" | "warning" | "error" | "dim" {
	if (status === "exhausted") return "error";
	if (status === "warning") return "warning";
	if (status === "ok") return "success";
	return "dim";
}

export function renderUsageBar(limit: UsageLimit, uiTheme: typeof theme, barWidth: number): string {
	const fraction = resolveUsedFraction(limit);
	if (fraction === undefined) {
		return uiTheme.fg("dim", "·".repeat(barWidth));
	}
	const ramp = uiTheme.getBarRamp();
	const bar = subCellBar(clamp01(fraction), barWidth, { ramp });
	const trackAt = bar.indexOf(ramp.track);
	const color = resolveStatusColor(limit.status);
	return trackAt < 0
		? uiTheme.fg(color, bar)
		: `${uiTheme.fg(color, bar.slice(0, trackAt))}${uiTheme.fg("dim", bar.slice(trackAt))}`;
}

export function resolveColumnWidth(count: number, available: number, trailing: number): number {
	if (count <= 0) return BAR_WIDTH_MAX;
	const indent = 2;
	const gaps = count - 1;
	const spaceForBars = available - indent - gaps - (trailing > 0 ? trailing + 1 : 0);
	const ideal = Math.floor(spaceForBars / count);
	const min = BAR_WIDTH_MIN;
	const max = BAR_WIDTH_MAX;
	if (ideal < min) return min;
	if (ideal > max) return max;
	return ideal;
}

export function renderUsageReports(
	reports: UsageReport[],
	uiTheme: typeof theme,
	nowMs: number,
	availableWidth: number,
	resolveActiveAccount?: (provider: string) => OAuthAccountIdentity | undefined,
): string {
	const lines: string[] = [];
	let latestFetchedAt = 0;
	for (let ri = 0; ri < reports.length; ri++) {
		const fetchedAt = reports[ri]!.fetchedAt ?? 0;
		if (fetchedAt > latestFetchedAt) latestFetchedAt = fetchedAt;
	}
	const headerSuffix = latestFetchedAt ? ` (${formatDuration(nowMs - latestFetchedAt)} ago)` : "";
	lines.push(uiTheme.bold(uiTheme.fg("accent", `Usage${headerSuffix}`)));
	const grouped = new Map<string, UsageReport[]>();
	for (const report of reports) {
		const list = grouped.get(report.provider) ?? [];
		list.push(report);
		grouped.set(report.provider, list);
	}
	const providerEntries = Array.from(grouped.entries())
		.map(([provider, providerReports]) => ({
			provider,
			providerReports,
			totalUsage: resolveProviderUsageTotal(providerReports),
		}))
		.sort((a, b) => {
			if (a.totalUsage !== b.totalUsage) return a.totalUsage - b.totalUsage;
			return a.provider.localeCompare(b.provider);
		});

	for (const { provider, providerReports } of providerEntries) {
		lines.push("");
		const providerName = formatProviderName(provider);
		const activeAccount = resolveActiveAccount?.(provider);

		const limitGroups = new Map<
			string,
			{ label: string; windowLabel: string; limits: UsageLimit[]; reports: UsageReport[] }
		>();
		for (const report of providerReports) {
			for (const limit of report.limits) {
				const windowId = limit.window?.id ?? limit.scope.windowId ?? "default";
				const key = `${formatLimitTitle(limit)}|${windowId}`;
				const windowLabel = limit.window?.label ?? windowId;
				const entry = limitGroups.get(key) ?? {
					label: formatLimitTitle(limit),
					windowLabel,
					limits: [],
					reports: [],
				};
				entry.limits.push(limit);
				entry.reports.push(report);
				limitGroups.set(key, entry);
			}
		}

		lines.push(uiTheme.bold(uiTheme.fg("accent", providerName)));
		const activeAccountLabel = activeAccount?.email ?? activeAccount?.accountId ?? activeAccount?.projectId;
		if (activeAccountLabel) {
			lines.push(`  ${uiTheme.fg("accent", "in use by this session:")} ${activeAccountLabel}`);
		}

		const providerNotesSet = new Set<string>();
		for (let ri = 0; ri < providerReports.length; ri++) {
			const notes = providerReports[ri]!.notes;
			if (notes) for (let ni = 0; ni < notes.length; ni++) providerNotesSet.add(notes[ni]!);
		}
		const providerNotes = Array.from(providerNotesSet);
		if (providerNotes.length > 0) {
			let notesJoined = "";
			for (let ni = 0; ni < providerNotes.length; ni++) {
				notesJoined += (ni > 0 ? " • " : "") + providerNotes[ni]!.replace(/[\r\n]+/g, " ");
			}
			lines.push(`  ${uiTheme.fg("dim", replaceTabs(truncateToWidth(sanitizeText(notesJoined), 110)))}`.trimEnd());
		}

		const resetAccountLines: string[] = [];
		for (const report of providerReports) {
			const count = report.resetCredits?.availableCount ?? 0;
			if (count <= 0) continue;
			const label =
				typeof report.metadata?.email === "string" && report.metadata.email
					? report.metadata.email
					: typeof report.metadata?.accountId === "string" && report.metadata.accountId
						? report.metadata.accountId
						: "account";
			const isActive =
				!!activeAccount &&
				((!!activeAccount.accountId && activeAccount.accountId === report.metadata?.accountId) ||
					(!!activeAccount.email && activeAccount.email === report.metadata?.email));
			resetAccountLines.push(
				`    • ${label}: ${count} saved reset${count === 1 ? "" : "s"}${isActive ? " (active)" : ""}`,
			);
			const credits = report.resetCredits?.credits;
			if (credits) {
				for (const credit of credits) {
					if (credit.expiresAt) {
						const expiryMs = Date.parse(credit.expiresAt);
						if (!Number.isNaN(expiryMs)) {
							const remaining = expiryMs - nowMs;
							const expiryDate = credit.expiresAt.slice(0, 10);
							if (remaining > 0) {
								resetAccountLines.push(`        expires in ${formatDuration(remaining)} (${expiryDate})`);
							} else {
								resetAccountLines.push(`        expired (${expiryDate})`);
							}
						}
					}
				}
			}
		}
		if (resetAccountLines.length > 0) {
			lines.push(
				`  ${uiTheme.fg("accent", "Saved rate-limit resets")} ${uiTheme.fg("dim", "(/usage reset to spend)")}`,
			);
			for (const line of resetAccountLines) lines.push(uiTheme.fg("dim", line));
		}

		const groupList = Array.from(limitGroups.values());
		const renderableGroups = new Array<{
			group: (typeof groupList)[number];
			sortedLimits: UsageLimit[];
			sortedReports: UsageReport[];
			amountText: string;
		}>(groupList.length);
		for (let gi = 0; gi < groupList.length; gi++) {
			const group = groupList[gi]!;
			const entries = new Array<{
				limit: UsageLimit;
				report: UsageReport;
				fraction: number | undefined;
				index: number;
			}>(group.limits.length);
			for (let li = 0; li < group.limits.length; li++) {
				entries[li] = {
					limit: group.limits[li]!,
					report: group.reports[li],
					fraction: resolveUsedFraction(group.limits[li]!),
					index: li,
				};
			}
			entries.sort((a, b) => {
				const aFraction = a.fraction ?? -1;
				const bFraction = b.fraction ?? -1;
				if (aFraction !== bFraction) return bFraction - aFraction;
				return a.index - b.index;
			});
			const sortedLimits = new Array<UsageLimit>(entries.length);
			const sortedReports = new Array<UsageReport>(entries.length);
			for (let ei = 0; ei < entries.length; ei++) {
				sortedLimits[ei] = entries[ei]!.limit;
				sortedReports[ei] = entries[ei]!.report;
			}
			renderableGroups[gi] = { group, sortedLimits, sortedReports, amountText: formatAggregateAmount(sortedLimits) };
		}

		let sectionCount = 0;
		let sectionTrailing = 0;
		for (let gi = 0; gi < renderableGroups.length; gi++) {
			const g = renderableGroups[gi]!;
			if (g.sortedLimits.length > sectionCount) sectionCount = g.sortedLimits.length;
			const aw = visibleWidth(g.amountText);
			if (aw > sectionTrailing) sectionTrailing = aw;
		}
		const sectionColumnWidth = resolveColumnWidth(sectionCount, availableWidth, sectionTrailing);

		for (let gi = 0; gi < renderableGroups.length; gi++) {
			const { group, sortedLimits, sortedReports, amountText } = renderableGroups[gi]!;
			const status = resolveAggregateStatus(sortedLimits);
			const statusIcon = resolveStatusIcon(status, uiTheme);

			const windowSuffix = formatWindowSuffix(group.label, group.windowLabel, uiTheme);
			lines.push(`${statusIcon} ${uiTheme.bold(group.label)} ${windowSuffix}`.trim());
			const accountLabels = formatAccountHeaderRow(
				sortedLimits,
				sortedReports,
				nowMs,
				sectionColumnWidth,
				uiTheme,
				activeAccount,
			);
			lines.push(`  ${accountLabels.join(" ")}`.trimEnd());
			const bars: string[] = new Array(sortedLimits.length);
			for (let bi = 0; bi < sortedLimits.length; bi++) {
				bars[bi] = padColumn(renderUsageBar(sortedLimits[bi]!, uiTheme, sectionColumnWidth), sectionColumnWidth);
			}
			lines.push(`  ${bars.join(" ")} ${amountText}`.trimEnd());
			const notesSet = new Set<string>();
			for (let li = 0; li < sortedLimits.length; li++) {
				const notes = sortedLimits[li]!.notes;
				if (notes) for (let ni = 0; ni < notes.length; ni++) notesSet.add(notes[ni]!);
			}
			const notes = Array.from(notesSet);
			const resetText = sortedLimits.length <= 1 ? resolveResetRange(sortedLimits, nowMs) : null;
			if (resetText) {
				lines.push(`  ${uiTheme.fg("dim", resetText)}`.trimEnd());
			}
			if (notes.length > 0) {
				let acctNotesJoined = "";
				for (let ni = 0; ni < notes.length; ni++) {
					acctNotesJoined += (ni > 0 ? " • " : "") + notes[ni]!.replace(/[\r\n]+/g, " ");
				}
				lines.push(
					`  ${uiTheme.fg("dim", replaceTabs(truncateToWidth(sanitizeText(acctNotesJoined), 110)))}`.trimEnd(),
				);
			}
		}

		const unlimitedReports = providerReports.filter(report => report.limits.length === 0);
		for (const report of unlimitedReports) {
			const label = formatUnlimitedReportLabel(report, 0);
			const tier = report.metadata?.planType;
			const tierSuffix = typeof tier === "string" && tier ? ` ${uiTheme.fg("dim", `(${tier})`)}` : "";
			lines.push(
				`${uiTheme.fg("success", uiTheme.status.success)} ${label}${tierSuffix} ${uiTheme.fg("dim", "-- no limits")}`,
			);
		}
	}

	return lines.join("\n");
}
