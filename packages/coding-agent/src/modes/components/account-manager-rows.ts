/** Row shaping for the account manager card: an {@link AccountInventory} in, the mockup's display lines out. */
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

/** One line of display text, made safe for a single terminal row. Every C0 control — tab, carriage return, newline, and the escape that would let an upstream */
export function sanitizeAccountText(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

/** A provider row in the manager's sidebar. */
export interface AccountSidebarEntry {
	providerId: string;
	label: string;
	/** Credentials stored for this provider. Zero for a provider offered only so `a` can add one. */
	accountCount: number;
	/** Right-aligned count text: the number, or {@link NO_ACCOUNTS_ANNOTATION} when the provider holds nothing. The unhealthy marker is NOT folded in here — see {@link hasFailure}. */
	annotation: string;
	/** True when at least one of this provider's rows failed its last probe. The caller appends the warning glyph, because which glyph that is depends on the active symbol preset. */
	hasFailure: boolean;
}

/** A provider the sidebar can offer, whether or not it currently holds credentials. */
export interface AccountProviderChoice {
	id: string;
	label: string;
}

/** The sidebar's provider list: everything holding credentials, plus every provider a login is available for. */
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
			// A torn-down login counts as needing attention even when a sibling still works: the
			// provider is the only place that fact can surface, and a provider whose ONLY login died
			// has no row left to carry it.
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

/** The sidebar's footer tally: `7 accounts · 1 error`. */
export function sidebarSummaryLine(inventory: AccountInventory): string {
	const accounts = `${inventory.totalAccounts} ${inventory.totalAccounts === 1 ? "account" : "accounts"}`;
	if (inventory.unhealthyCount === 0) return accounts;
	return `${accounts} · ${inventory.unhealthyCount} ${inventory.unhealthyCount === 1 ? "error" : "errors"}`;
}

/** The note a provider shows when a previous login was torn down by a failed refresh. Prints the upstream cause verbatim, like a failed row does: `invalid_grant: The provided */
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
	let unhealthy = 0;
	for (let ri = 0; ri < rows.length; ri++) {
		if (rows[ri]!.health === "failed") unhealthy++;
	}
	const counted = `${clean} · ${rows.length} ${rows.length === 1 ? "account" : "accounts"}`;
	return unhealthy === 0 ? counted : `${counted} · ${unhealthy} ${unhealthy === 1 ? "needs" : "need"} attention`;
}

/** Which status mark a row wears. Ordered by what the user has to act on. A failed credential outranks everything because it */
export type AccountGlyphKind = "serving" | "idle" | "failed" | "blocked";

/** A login that has ENDED: the access token is past its expiry and no refresh token is stored. The one credential state that has to be marked, and the reason it is a named predicate rather */
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

/** The head line's three fields. The tag ladder deliberately puts ROUTING first, which is the opposite of the glyph ladder in */
export function accountHeadLine(row: AccountRow, nowMs: number): AccountHeadLine {
	const detail = accountIdentityDetail(row)[0] ?? "";
	let tag = "";
	// A serving row the user CHOSE says both. `activeForSession` used to swallow the choice, so pressing enter on the account already serving changed nothing on screen: the choice was
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

/** The second line of a row: whatever identity the head line could not carry, then the origin badge. */
export function accountPlanLine(row: AccountRow): string {
	const parts: string[] = [];
	// The plan leads the line: it is the fact that distinguishes two accounts on one email and the
	// one a user checks before switching. Absent until the usage probe reports a tier.
	if (row.planTier) parts.push(sanitizeAccountText(row.planTier));
	const identityDetail = accountIdentityDetail(row).slice(1);
	for (let pi = 0; pi < identityDetail.length; pi++) parts.push(sanitizeAccountText(identityDetail[pi]!));
	const origin = accountOriginLabel(row);
	if (origin) parts.push(sanitizeAccountText(origin));
	return parts.join(" · ");
}

/** One line per usage window: `5 Hour [███▍░░░░░░] 34% resets in 4h`. The label column is sized against THIS account's own labels, so an account whose bars carry a */
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

/** The lines a row only shows when something is wrong. A FAILED row prints the upstream reason VERBATIM (sanitized, never truncated here). Replacing */
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

/** The two lines a provider shows when the account the user chose is not the one serving. This exists so the card never presents the substitute as a choice. The rotation happened to */
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
		// The countdown is this product's own estimate of when the provider will serve again, and the provider can lift a limit by routes this process never sees. Naming only the wait
		lines.push(
			`enter switches back to ${chosen} · on hold for ${formatDurationCoarse(until - nowMs)} · c lifts the hold`,
		);
	} else {
		lines.push(`enter switches back to ${chosen}`);
	}
	return lines;
}
