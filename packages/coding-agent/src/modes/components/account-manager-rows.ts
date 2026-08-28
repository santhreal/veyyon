import {
	type AccountInventory,
	type AccountRow,
	accountCredentialStatus,
	accountDisplayLabel,
	accountIdentityDetail,
	accountOriginLabel,
	credentialStateNote,
} from "../../session/account-inventory";
import {
	formatDurationCoarse,
	formatUsageWindowLine,
	usageWindowLabelColumn,
} from "../../slash-commands/helpers/format";

export const USAGE_BAR_WIDTH = 10;

export const NO_ACCOUNTS_ANNOTATION = "—";

export function sanitizeAccountText(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

export interface AccountSidebarEntry {
	providerId: string;
	label: string;
	accountCount: number;
	annotation: string;
	hasFailure: boolean;
}

export interface AccountProviderChoice {
	id: string;
	label: string;
}

export function buildSidebarEntries(
	inventory: AccountInventory,
	providers: readonly AccountProviderChoice[],
): AccountSidebarEntry[] {
	const entries = new Map<string, AccountSidebarEntry>();
	for (let gi = 0; gi < inventory.providers.length; gi++) {
		const group = inventory.providers[gi]!;
		let hasFailure = group.disabledCause !== undefined;
		if (!hasFailure) {
			for (let ri = 0; ri < group.rows.length; ri++) {
				if (group.rows[ri]!.health === "failed") {
					hasFailure = true;
					break;
				}
			}
		}
		entries.set(group.provider, {
			providerId: group.provider,
			label: sanitizeAccountText(group.label),
			accountCount: group.rows.length,
			annotation: group.rows.length > 0 ? String(group.rows.length) : NO_ACCOUNTS_ANNOTATION,
			hasFailure,
		});
	}
	for (let pi = 0; pi < providers.length; pi++) {
		const provider = providers[pi]!;
		if (entries.has(provider.id)) continue;
		entries.set(provider.id, {
			providerId: provider.id,
			label: sanitizeAccountText(provider.label),
			accountCount: 0,
			annotation: NO_ACCOUNTS_ANNOTATION,
			hasFailure: false,
		});
	}
	const all = Array.from(entries.values());
	const populated: AccountSidebarEntry[] = [];
	const empty: AccountSidebarEntry[] = [];
	for (let ei = 0; ei < all.length; ei++) {
		const entry = all[ei]!;
		if (entry.accountCount > 0) populated.push(entry);
		else empty.push(entry);
	}
	populated.sort((a, b) => a.label.localeCompare(b.label));
	empty.sort((a, b) => a.label.localeCompare(b.label));
	return populated.concat(empty);
}

export function sidebarSummaryLine(inventory: AccountInventory): string {
	const accounts = `${inventory.totalAccounts} ${inventory.totalAccounts === 1 ? "account" : "accounts"}`;
	if (inventory.unhealthyCount === 0) return accounts;
	return `${accounts} · ${inventory.unhealthyCount} ${inventory.unhealthyCount === 1 ? "error" : "errors"}`;
}

export function providerDisabledNote(entry: { disabledCause?: string; rows: readonly AccountRow[] }): string[] {
	if (!entry.disabledCause) return [];
	const lead =
		entry.rows.length === 0 ? "the login for this provider was signed out" : "a previous login was signed out";
	return [`${lead}: ${sanitizeAccountText(entry.disabledCause)}`, "press a to sign in again"];
}

export function providerHeaderLine(label: string, rows: readonly AccountRow[]): string {
	const clean = sanitizeAccountText(label);
	if (rows.length === 0) return `${clean} · no accounts yet`;
	let unhealthy = 0;
	for (let ri = 0; ri < rows.length; ri++) {
		if (rows[ri]!.health === "failed") unhealthy++;
	}
	const counted = `${clean} · ${rows.length} ${rows.length === 1 ? "account" : "accounts"}`;
	return unhealthy === 0 ? counted : `${counted} · ${unhealthy} ${unhealthy === 1 ? "needs" : "need"} attention`;
}

export type AccountGlyphKind = "serving" | "idle" | "failed" | "blocked";

function expiredWithoutRefresh(row: AccountRow, nowMs: number): boolean {
	const status = accountCredentialStatus(row, nowMs);
	return status.state === "expired" && !status.renewable;
}

export function accountGlyphKind(row: AccountRow, nowMs: number): AccountGlyphKind {
	if (row.health === "failed") return "failed";
	if (expiredWithoutRefresh(row, nowMs)) return "failed";
	if (accountCredentialStatus(row, nowMs).state === "blocked") return "blocked";
	return row.activeForSession ? "serving" : "idle";
}

export interface AccountHeadLine {
	label: string;
	detail: string;
	tag: string;
}

export function accountHeadLine(row: AccountRow, nowMs: number): AccountHeadLine {
	const detail = accountIdentityDetail(row)[0] ?? "";
	let tag = "";
	const routed = row.activeIsPrediction ? "serves next" : "serving";
	if (row.activeForSession) tag = row.selectedForProvider ? `${routed} · your choice` : routed;
	else if (row.selectedForProvider) tag = "your choice";
	else if (row.blockedUntilMs !== undefined && row.blockedUntilMs > nowMs) tag = "rate limited";
	else if (row.health === "failed") tag = "needs attention";
	else if (expiredWithoutRefresh(row, nowMs)) tag = "needs attention";
	return {
		label: sanitizeAccountText(accountDisplayLabel(row)),
		detail: sanitizeAccountText(detail),
		tag,
	};
}

export function accountPlanLine(row: AccountRow): string {
	const parts: string[] = [];
	if (row.planTier) parts.push(sanitizeAccountText(row.planTier));
	const identityDetail = accountIdentityDetail(row).slice(1);
	for (let pi = 0; pi < identityDetail.length; pi++) parts.push(sanitizeAccountText(identityDetail[pi]!));
	const origin = accountOriginLabel(row);
	if (origin) parts.push(sanitizeAccountText(origin));
	return parts.join(" · ");
}

export function accountUsageLines(row: AccountRow, nowMs: number): string[] {
	const labels = new Array<string>(row.usage.length);
	for (let wi = 0; wi < row.usage.length; wi++) labels[wi] = sanitizeAccountText(row.usage[wi]!.label);
	const column = usageWindowLabelColumn(labels);
	const result = new Array<string>(row.usage.length);
	for (let wi = 0; wi < row.usage.length; wi++) {
		const window = row.usage[wi]!;
		const resets =
			window.resetsAtMs === undefined
				? undefined
				: `   resets in ${formatDurationCoarse(Math.max(0, window.resetsAtMs - nowMs))}`;
		result[wi] = formatUsageWindowLine(labels[wi] ?? "", window.usedFraction, USAGE_BAR_WIDTH, resets, column);
	}
	return result;
}

export function accountNoticeLines(row: AccountRow, nowMs: number): string[] {
	const lines: string[] = [];
	if (row.health === "failed" && row.healthReason) lines.push(sanitizeAccountText(row.healthReason));
	if (row.blockedUntilMs !== undefined && row.blockedUntilMs > nowMs) {
		lines.push(`rate limited · unblocks in ${formatDurationCoarse(row.blockedUntilMs - nowMs)}`);
	}
	const credential = credentialStateNote(row, nowMs);
	if (credential) lines.push(`${credential} · press a to sign in again`);
	return lines;
}

export function divergenceLines(divergence: { chosen: AccountRow; serving: AccountRow }, nowMs: number): string[] {
	const chosen = sanitizeAccountText(accountDisplayLabel(divergence.chosen));
	const serving = sanitizeAccountText(accountDisplayLabel(divergence.serving));
	const lines = [
		divergence.serving.activeIsPrediction
			? `you chose ${chosen}; it cannot serve, so the next request uses ${serving}`
			: `you chose ${chosen}, rotated off it onto ${serving}`,
	];
	const until = divergence.chosen.blockedUntilMs;
	if (until !== undefined && until > nowMs) {
		lines.push(
			`enter switches back to ${chosen} · on hold for ${formatDurationCoarse(until - nowMs)} · c lifts the hold`,
		);
	} else {
		lines.push(`enter switches back to ${chosen}`);
	}
	return lines;
}
