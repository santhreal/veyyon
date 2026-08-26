/**
 * Row shaping for the account manager card: converts an {@link AccountInventory} into display rows.
 * Sanitizes upstream text and resolves status tags and glyphs.
 */
import { countWhere, partition } from "@veyyon/utils";
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

/** Width of the usage bar in the manager's body pane, in cells. */
export const USAGE_BAR_WIDTH = 10;

/** Annotation a sidebar entry carries when the provider holds no credentials at all. */
export const NO_ACCOUNTS_ANNOTATION = "—";

/**
 * Collapses C0 control characters in display text to single spaces to preserve terminal row layout.
 */
export function sanitizeAccountText(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

/** A provider row in the manager's sidebar. */
export interface AccountSidebarEntry {
	providerId: string;
	label: string;
	/** Credentials stored for this provider. Zero for a provider offered only so `a` can add one. */
	accountCount: number;
	/**
	 * Right-aligned count text: the number, or {@link NO_ACCOUNTS_ANNOTATION} when the provider
	 * holds nothing. The unhealthy marker is NOT folded in here — see {@link hasFailure}.
	 */
	annotation: string;
	/**
	 * True when at least one of this provider's rows failed its last probe. The caller appends
	 * the warning glyph, because which glyph that is depends on the active symbol preset.
	 */
	hasFailure: boolean;
}

/** A provider the sidebar can offer, whether or not it currently holds credentials. */
export interface AccountProviderChoice {
	id: string;
	label: string;
}

/**
 * Builds the sidebar's provider list, sorting providers with active credentials before empty ones.
 */
export function buildSidebarEntries(
	inventory: AccountInventory,
	providers: readonly AccountProviderChoice[],
): AccountSidebarEntry[] {
	const entries = new Map<string, AccountSidebarEntry>();
	for (const group of inventory.providers) {
		entries.set(group.provider, {
			providerId: group.provider,
			label: sanitizeAccountText(group.label),
			accountCount: group.rows.length,
			annotation: group.rows.length > 0 ? String(group.rows.length) : NO_ACCOUNTS_ANNOTATION,
			// A torn-down login counts as needing attention even when a sibling still works: the
			// provider is the only place that fact can surface, and a provider whose ONLY login died
			// has no row left to carry it.
			hasFailure: group.rows.some(row => row.health === "failed") || group.disabledCause !== undefined,
		});
	}
	for (const provider of providers) {
		if (entries.has(provider.id)) continue;
		entries.set(provider.id, {
			providerId: provider.id,
			label: sanitizeAccountText(provider.label),
			accountCount: 0,
			annotation: NO_ACCOUNTS_ANNOTATION,
			hasFailure: false,
		});
	}
	const [populatedEntries, emptyEntries] = partition([...entries.values()], entry => entry.accountCount > 0);
	const populated = populatedEntries.sort((a, b) => a.label.localeCompare(b.label));
	const empty = emptyEntries.sort((a, b) => a.label.localeCompare(b.label));
	return [...populated, ...empty];
}

/** The sidebar's footer tally: `7 accounts · 1 error`. */
export function sidebarSummaryLine(inventory: AccountInventory): string {
	const accounts = `${inventory.totalAccounts} ${inventory.totalAccounts === 1 ? "account" : "accounts"}`;
	if (inventory.unhealthyCount === 0) return accounts;
	return `${accounts} · ${inventory.unhealthyCount} ${inventory.unhealthyCount === 1 ? "error" : "errors"}`;
}

/**
 * Formats the explanatory note when a provider login was invalidated by a failed token refresh.
 */
export function providerDisabledNote(entry: { disabledCause?: string; rows: readonly AccountRow[] }): string[] {
	if (!entry.disabledCause) return [];
	const lead =
		entry.rows.length === 0 ? "the login for this provider was signed out" : "a previous login was signed out";
	return [`${lead}: ${sanitizeAccountText(entry.disabledCause)}`, "press a to sign in again"];
}

/** The body pane's title line: `Anthropic · 3 accounts · 1 needs attention`. */
export function providerHeaderLine(label: string, rows: readonly AccountRow[]): string {
	const clean = sanitizeAccountText(label);
	if (rows.length === 0) return `${clean} · no accounts yet`;
	const unhealthy = countWhere(rows, row => row.health === "failed");
	const counted = `${clean} · ${rows.length} ${rows.length === 1 ? "account" : "accounts"}`;
	return unhealthy === 0 ? counted : `${counted} · ${unhealthy} ${unhealthy === 1 ? "needs" : "need"} attention`;
}

/**
 * Status mark classification for an account row, prioritizing failures and rate limits over routing.
 */
export type AccountGlyphKind = "serving" | "idle" | "failed" | "blocked";

/**
 * Returns true when an expired access token cannot be refreshed because no refresh token is stored.
 */
function expiredWithoutRefresh(row: AccountRow, nowMs: number): boolean {
	const status = accountCredentialStatus(row, nowMs);
	return status.state === "expired" && !status.renewable;
}

export function accountGlyphKind(row: AccountRow, nowMs: number): AccountGlyphKind {
	if (row.health === "failed") return "failed";
	// An expired access token with no refresh token beside it is a login that has ENDED. It cannot
	// serve a request and no waiting fixes it, which is exactly what the failure mark means; the
	// renewable form of the same expiry renews itself and wears no mark at all.
	if (expiredWithoutRefresh(row, nowMs)) return "failed";
	if (accountCredentialStatus(row, nowMs).state === "blocked") return "blocked";
	return row.activeForSession ? "serving" : "idle";
}

/** The three fields of a row's first line, before the caller adds a glyph and a cursor. */
export interface AccountHeadLine {
	/** {@link accountDisplayLabel}, sanitized. The only label ladder there is. */
	label: string;
	/** The strongest identity fact the label did not already say (usually the email). */
	detail: string;
	/** Right-aligned routing tag: `serving`, `your choice`, `rate limited`, `needs attention`. */
	tag: string;
}

/**
 * Formats the three head line fields (label, detail, routing tag) for an account row.
 */
export function accountHeadLine(row: AccountRow, nowMs: number): AccountHeadLine {
	const detail = accountIdentityDetail(row)[0] ?? "";
	let tag = "";
	// A serving row the user CHOSE says both. `activeForSession` used to swallow the choice, so
	// pressing enter on the account already serving changed nothing on screen: the choice was
	// recorded and the card was byte-identical. The host's confirmation goes to the transcript,
	// which is BEHIND this fullscreen card, so the row itself is the only place feedback can land.
	//
	// "your choice" rather than "pinned": the choice outlives this session and this profile, and a
	// word that says "for now" would misdescribe what pressing enter did.
	//
	// `serves next` RATHER THAN `serving` when the routing is a prediction, which is the state a
	// fresh session opens in: nothing has been spent through this account, so calling it "serving"
	// claims traffic that has not happened. Before the routing could predict at all this row wore
	// no tag whatsoever, and the card could not answer the one question it exists for until the
	// operator had sent a request and reopened it.
	const routed = row.activeIsPrediction ? "serves next" : "serving";
	if (row.activeForSession) tag = row.selectedForProvider ? `${routed} · your choice` : routed;
	else if (row.selectedForProvider) tag = "your choice";
	else if (row.blockedUntilMs !== undefined && row.blockedUntilMs > nowMs) tag = "rate limited";
	else if (row.health === "failed") tag = "needs attention";
	// Same words as a failed probe, because it is the same ask of the reader: this row needs a
	// login. Only the non-renewable form: an expired token with a refresh beside it renews itself
	// on the next request, and telling a reader to attend to that is telling them to do nothing.
	else if (expiredWithoutRefresh(row, nowMs)) tag = "needs attention";
	return {
		label: sanitizeAccountText(accountDisplayLabel(row)),
		detail: sanitizeAccountText(detail),
		tag,
	};
}

/**
 * Formats the second line of an account row containing plan tier, detail, and origin badge.
 */
export function accountPlanLine(row: AccountRow): string {
	const parts: string[] = [];
	// The plan leads the line: it is the fact that distinguishes two accounts on one email and the
	// one a user checks before switching. Absent until the usage probe reports a tier.
	if (row.planTier) parts.push(sanitizeAccountText(row.planTier));
	parts.push(
		...accountIdentityDetail(row)
			.slice(1)
			.map(part => sanitizeAccountText(part)),
	);
	const origin = accountOriginLabel(row);
	if (origin) parts.push(sanitizeAccountText(origin));
	return parts.join(" · ");
}

/**
 * Formats usage bar lines for each window tracked by an account.
 */
export function accountUsageLines(row: AccountRow, nowMs: number): string[] {
	const labels = row.usage.map(window => sanitizeAccountText(window.label));
	const column = usageWindowLabelColumn(labels);
	return row.usage.map((window, index) => {
		const resets =
			window.resetsAtMs === undefined
				? undefined
				: `   resets in ${formatDurationCoarse(Math.max(0, window.resetsAtMs - nowMs))}`;
		return formatUsageWindowLine(labels[index] ?? "", window.usedFraction, USAGE_BAR_WIDTH, resets, column);
	});
}

/**
 * Formats error, rate-limit, and re-authentication notice lines for an account row.
 */
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

/**
 * Formats explanatory lines when the active serving account diverges from the user's selected choice.
 */
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
		// The countdown is this product's own estimate of when the provider will serve again, and
		// the provider can lift a limit by routes this process never sees. Naming only the wait
		// left the operator with nothing to do about an account the provider would already serve —
		// which is exactly the state a redeemed reset leaves, since nothing but time cleared a hold.
		lines.push(
			`enter switches back to ${chosen} · on hold for ${formatDurationCoarse(until - nowMs)} · c lifts the hold`,
		);
	} else {
		lines.push(`enter switches back to ${chosen}`);
	}
	return lines;
}
