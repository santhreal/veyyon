/**
 * Row shaping for the account manager card: an {@link AccountInventory} in, the mockup's
 * display lines out.
 *
 * WHY THIS IS ITS OWN MODULE. The card that hosts these lines owns a viewport, a focus model,
 * a rename input and mouse routing, and none of that has an opinion about what an account row
 * SAYS. Splitting the wording out means the wording can be asserted against fixed inventories
 * with no terminal, no theme and no geometry, and it means the one place that decides "a failed
 * row prints its upstream reason verbatim underneath" is a function rather than a branch buried
 * in a render loop.
 *
 * WHAT IT DOES NOT DO. No theme, no ANSI of its own, no width. Glyphs are named by
 * {@link accountGlyphKind} and resolved by the caller through `theme.status.*`, because the
 * glyph a terminal can actually draw is a theme decision (the ascii preset has no `●`), and a
 * pure module that hard-coded `●` would be wrong on exactly the terminals that need help most.
 * Widths belong to the caller too: it is the one that knows the pane it is painting into.
 *
 * Every string that crosses this module from upstream (an OAuth error body, a provider's window
 * label, an account name a user typed) is put through {@link sanitizeAccountText} first. A tab
 * or a newline in an upstream failure reason tears a card open, and those strings arrive from
 * the network.
 */
import type { AccountInventory, AccountRow } from "../../session/account-inventory";
import { accountDisplayLabel, accountIdentityDetail, accountOriginLabel } from "../../session/account-inventory";
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
 * One line of display text, made safe for a single terminal row.
 *
 * Every C0 control — tab, carriage return, newline, and the escape that would let an upstream
 * string repaint the card — collapses to a single space, so a three-line OAuth error body
 * occupies one row instead of shredding the frame. This is deliberately stronger than the usual
 * `replaceTabs`: a card row has no tab stops, so one space is the right rendering of a tab here
 * and four would only push the row toward the border for no gain.
 *
 * Truncation is deliberately NOT done here: the caller knows the pane width.
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
 * The sidebar's provider list: everything holding credentials, plus every provider a login is
 * available for.
 *
 * The union is what makes `a` reachable for a provider you have never signed into — a sidebar
 * built from stored credentials alone can only ever show you accounts you already have, so the
 * first account for a provider would have to be added from somewhere else. The union runs the
 * other way too: a provider authenticated by an api key or an env var holds credentials without
 * offering an OAuth login, and dropping it would hide real accounts.
 *
 * Providers holding credentials sort first, alphabetically by label, then the empty ones. That
 * ordering is the point of the card: what you have, before what you could have.
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
	const all = Array.from(entries.values());
	const populated = all.filter(entry => entry.accountCount > 0).sort((a, b) => a.label.localeCompare(b.label));
	const empty = all.filter(entry => entry.accountCount === 0).sort((a, b) => a.label.localeCompare(b.label));
	return [...populated, ...empty];
}

/** The sidebar's footer tally: `7 accounts · 1 error`. */
export function sidebarSummaryLine(inventory: AccountInventory): string {
	const accounts = `${inventory.totalAccounts} ${inventory.totalAccounts === 1 ? "account" : "accounts"}`;
	if (inventory.unhealthyCount === 0) return accounts;
	return `${accounts} · ${inventory.unhealthyCount} ${inventory.unhealthyCount === 1 ? "error" : "errors"}`;
}

/**
 * The note a provider shows when a previous login was torn down by a failed refresh.
 *
 * Prints the upstream cause verbatim, like a failed row does: `invalid_grant: The provided
 * authorization grant is invalid` is what tells a user the grant died on the provider's side and a
 * fresh login is the remedy, where "signed out" would leave them re-running the same broken flow.
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
	const unhealthy = rows.filter(row => row.health === "failed").length;
	const counted = `${clean} · ${rows.length} ${rows.length === 1 ? "account" : "accounts"}`;
	return unhealthy === 0 ? counted : `${counted} · ${unhealthy} ${unhealthy === 1 ? "needs" : "need"} attention`;
}

/**
 * Which status mark a row wears.
 *
 * Ordered by what the user has to act on. A failed credential outranks everything because it
 * will not work again without a login; a rate-limit block outranks routing because the row is
 * temporarily unusable however it is routed; only then does it matter whether this row is the
 * one serving the session.
 */
export type AccountGlyphKind = "serving" | "idle" | "failed" | "blocked";

export function accountGlyphKind(row: AccountRow, nowMs: number): AccountGlyphKind {
	if (row.health === "failed") return "failed";
	if (row.blockedUntilMs !== undefined && row.blockedUntilMs > nowMs) return "blocked";
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
 * The head line's three fields.
 *
 * The tag ladder deliberately puts ROUTING first, which is the opposite of the glyph ladder in
 * {@link accountGlyphKind}. A row that is serving the session AND failing its probe reads
 * `✗ work … this session`: the glyph already carries the failure, and the fact worth stating in
 * the one right-aligned slot is that this broken credential is the one your next request goes
 * to. Reversing it would print `needs attention` on the routed row and leave nothing at all
 * saying which account is routed, which is the question the card exists to answer.
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
	if (row.activeForSession) tag = row.selectedForProvider ? "serving · your choice" : "serving";
	else if (row.selectedForProvider) tag = "your choice";
	else if (row.blockedUntilMs !== undefined && row.blockedUntilMs > nowMs) tag = "rate limited";
	else if (row.health === "failed") tag = "needs attention";
	return {
		label: sanitizeAccountText(accountDisplayLabel(row)),
		detail: sanitizeAccountText(detail),
		tag,
	};
}

/**
 * The second line of a row: whatever identity the head line could not carry, then the origin
 * badge.
 *
 * The origin badge is never dropped. `env: COPILOT_GITHUB_TOKEN` and `login` are different
 * facts about how you are authenticated, and a card that renders them identically cannot
 * explain why unsetting a shell variable signed you out.
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
 * One line per usage window: `5 Hour   [███░░░░░░░] 34%   resets in 4h`.
 *
 * The label column is sized against THIS account's own labels, so an account whose bars carry a
 * qualifier (`Daily · Anthropic`) still lines its bars up without padding an account whose windows
 * are plain out to the same width.
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
 * The lines a row only shows when something is wrong.
 *
 * A FAILED row prints the upstream reason VERBATIM (sanitized, never truncated here). Replacing
 * `invalid_grant: refresh token revoked` with "login failed" is what makes a user re-run the same
 * broken login three times; the exact string is the only thing that tells them the refresh token
 * was revoked on the provider's side.
 *
 * An UNVERIFIABLE row prints nothing. `checkCredentials` reports `ok: null` with a reason whenever
 * no probe exists for the provider, and that reason is a sentence about Veyyon's own plumbing:
 * `no usage probe configured for provider anthropic`. A live run put that line under EVERY healthy
 * Anthropic account, which reads as two broken logins. A working account must never carry a
 * warning, and an internal diagnostic is not an account problem. `/account status` already only
 * printed the reason for a failure, so this is also the two surfaces agreeing again.
 */
export function accountNoticeLines(row: AccountRow, nowMs: number): string[] {
	const lines: string[] = [];
	if (row.health === "failed" && row.healthReason) lines.push(sanitizeAccountText(row.healthReason));
	if (row.blockedUntilMs !== undefined && row.blockedUntilMs > nowMs) {
		lines.push(`rate limited · unblocks in ${formatDurationCoarse(row.blockedUntilMs - nowMs)}`);
	}
	return lines;
}

/**
 * The two lines a provider shows when the account the user chose is not the one serving.
 *
 * This exists so the card never presents the substitute as a choice. The rotation happened to
 * the user, not because of them, and a card that silently shows `personal · serving` after they
 * chose `work` reads as their own setting having changed.
 */
export function divergenceLines(divergence: { chosen: AccountRow; serving: AccountRow }, nowMs: number): string[] {
	const chosen = sanitizeAccountText(accountDisplayLabel(divergence.chosen));
	const serving = sanitizeAccountText(accountDisplayLabel(divergence.serving));
	const lines = [`you chose ${chosen}, rotated off it onto ${serving}`];
	const until = divergence.chosen.blockedUntilMs;
	if (until !== undefined && until > nowMs) {
		lines.push(`enter switches back to ${chosen} · ${formatDurationCoarse(until - nowMs)} until it unblocks`);
	} else {
		lines.push(`enter switches back to ${chosen}`);
	}
	return lines;
}
