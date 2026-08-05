/**
 * The inline `/account status` block: which account each provider is serving this session with.
 *
 * WHY IT IS A PURE FUNCTION. The same block is printed by the TUI (`showStatus`) and by text/ACP
 * clients (`runtime.output`), and the two used to be able to disagree. Taking an
 * {@link AccountInventory}, a clock reading and a role annotation map — and returning lines —
 * means both dispatchers print the same bytes, and a test can pin those bytes against fixed
 * inputs with no store, no probe and no clock behind it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never asks who is routed: `activeSessionAccounts` answers
 * that, and this file reports ONE BLOCK PER PROVIDER THAT ACTUALLY ROUTED rather than one per
 * configured provider, because a provider holding credentials the session never used is not "in
 * use". It never re-derives a display name either: `accountDisplayLabel` owns that ladder, so the
 * only thing this file adds is the `(no name set)` placeholder in the NAME column, which is a
 * statement about the name being absent rather than a sixth fallback for it.
 *
 * It also never presents a rotated substitute as the user's choice. When `pinnedButRotated`
 * reports divergence the block says what was pinned, what is serving instead and why, because a
 * silent swap is the failure this whole surface exists to make visible.
 */
import { replaceTabs, truncateToWidth } from "@veyyon/tui";
import { sanitizeText } from "@veyyon/utils";
import {
	type AccountInventory,
	type AccountRow,
	accountDisplayLabel,
	accountIdentityDetail,
	activeSessionAccounts,
	pinnedButRotated,
} from "../../session/account-inventory";
import { TRUNCATE_LENGTHS } from "../../tools/render-utils";
import { formatDurationCoarse, renderAsciiBar } from "./format";

/** Left margin of every account row, matching the other inline report blocks. */
const ROW_INDENT = "  ";
/** Width of the provider column, wide enough for the longest provider label plus a gap. */
const PROVIDER_COLUMN = 19;
/** Width of the account-name column, before the role annotations. */
const NAME_COLUMN = 28;
/** Continuation lines hang under the account name, not under the provider. */
const DETAIL_INDENT = " ".repeat(ROW_INDENT.length + PROVIDER_COLUMN);
/** Width of the usage-window label ("5h", "7d") before its bar. */
const USAGE_LABEL_COLUMN = 4;
/** A provider that names its windows in prose ("Claude 7 Day") may not eat the row. */
const USAGE_LABEL_MAX = 12;
/** Bar cells. Narrower than the `/usage` report's default: this block carries three columns. */
const USAGE_BAR_WIDTH = 10;

/** Shown in the NAME column when the user never named the account. */
export const NO_NAME_PLACEHOLDER = "(no name set)";
/** The invitation that follows an unnamed account. */
export const NAME_HINT = "/account name <text>";

/**
 * Search-provider preference → the credential providers that preference spends.
 *
 * Only the search backends that route through a stored ACCOUNT are listed, because only those can
 * appear in an account block. Every other search backend is an API key or a credential-free
 * scrape, which has no account to report and must not be made to look like one.
 */
export const WEB_SEARCH_CREDENTIAL_PROVIDERS: Readonly<Record<string, readonly string[]>> = {
	anthropic: ["anthropic"],
	codex: ["openai-codex"],
	gemini: ["google-gemini-cli", "google-antigravity"],
};

/** Where the roles a session routes come from. Resolved by the caller, annotated here. */
export interface AccountRoleSources {
	/** The session's main model, when one is resolved. */
	mainModel?: { provider: string; id: string };
	/** Providers of the models subagents run on, in role order. */
	subagentProviders?: readonly string[];
	/** The configured `providers.webSearch` preference, `auto` included. */
	webSearchPreference?: string;
}

/**
 * Which session roles each provider serves, as the block annotates them.
 *
 * The annotation is the answer to "why is this provider in my session at all", and it is per
 * PROVIDER rather than per account because that is the granularity routing works at: several
 * providers serve one session at once, and one of them can serve more than one role.
 */
export function accountRoleAnnotations(sources: AccountRoleSources): Map<string, string[]> {
	const roles = new Map<string, string[]>();
	const add = (provider: string, role: string): void => {
		const existing = roles.get(provider);
		if (!existing) {
			roles.set(provider, [role]);
			return;
		}
		if (!existing.includes(role)) existing.push(role);
	};

	if (sources.mainModel) add(sources.mainModel.provider, `main model  (${sources.mainModel.id})`);
	for (const provider of sources.subagentProviders ?? []) add(provider, "subagents");
	// `auto` is deliberately absent from the table: it resolves across every engine at call time, so
	// no single provider can be said to serve search. The table is the only authority here.
	for (const provider of WEB_SEARCH_CREDENTIAL_PROVIDERS[sources.webSearchPreference ?? ""] ?? []) {
		add(provider, "web search");
	}
	return roles;
}

/** Sanitize, de-tab and clamp one cell of display text, optionally padding it to a column. */
function cell(text: string, width: number, pad = false): string {
	return truncateToWidth(replaceTabs(sanitizeText(text)), width, undefined, pad);
}

/** Trailing padding is invisible but ends up in transcripts and exact-byte tests. */
function line(...parts: string[]): string {
	return parts.join("").trimEnd();
}

/** `5h  [███████░░░] 71%   resets in 2h` for one usage window. */
function usageLines(row: AccountRow, now: number): string[] {
	const lines: string[] = [];
	for (const window of row.usage) {
		const label = cell(window.label, USAGE_LABEL_MAX).padEnd(USAGE_LABEL_COLUMN);
		const bar = renderAsciiBar(window.usedFraction, USAGE_BAR_WIDTH);
		const resets =
			window.resetsAtMs !== undefined && window.resetsAtMs > now
				? `   resets in ${formatDurationCoarse(window.resetsAtMs - now)}`
				: "";
		lines.push(line(DETAIL_INDENT, label, bar, resets));
	}
	return lines;
}

/** Why a pin stopped serving, in the words the store actually has for it. */
function rotationReason(pinned: AccountRow, now: number): string {
	if (pinned.blockedUntilMs !== undefined && pinned.blockedUntilMs > now) return "usage limit";
	if (pinned.healthReason) return cell(pinned.healthReason, TRUNCATE_LENGTHS.CONTENT);
	return "unavailable";
}

/**
 * The two lines a rotated pin gets, naming the pin the user set and what replaced it.
 *
 * This is the case the surface exists for. The account serving the session is NOT the one they
 * chose, so the block reports the swap and how to undo it instead of printing the substitute's
 * name as though they had picked it.
 */
function divergenceLines(provider: string, pinned: AccountRow, now: number): string[] {
	const pinnedLabel = cell(accountDisplayLabel(pinned), TRUNCATE_LENGTHS.TITLE);
	const unblocks =
		pinned.blockedUntilMs !== undefined && pinned.blockedUntilMs > now
			? ` · ${formatDurationCoarse(pinned.blockedUntilMs - now)} until it unblocks`
			: "";
	return [
		line(DETAIL_INDENT, `pinned to ${pinnedLabel}, rotated off it (${rotationReason(pinned, now)})`),
		line(DETAIL_INDENT, `/account switch ${provider} to re-pin ${pinnedLabel}${unblocks}`),
	];
}

/**
 * The `/account status` block: one account per provider this session actually routed to.
 *
 * The footer's denominator is the number of providers you hold accounts FOR, not the number
 * veyyon supports: "3 of 6 providers in use" means three of your six credentialed providers have
 * routed something this session.
 *
 * @param inventory every stored account with this session's routing folded in
 * @param now epoch ms, so "resets in" and "until it unblocks" are the caller's clock, not a global
 * @param roles provider id → the session roles it serves, from {@link accountRoleAnnotations}
 */
export function renderAccountStatus(
	inventory: AccountInventory,
	now: number,
	roles: ReadonlyMap<string, readonly string[]>,
): string[] {
	const routed = new Map<string, AccountRow[]>();
	for (const row of activeSessionAccounts(inventory)) {
		const rows = routed.get(row.provider) ?? [];
		rows.push(row);
		routed.set(row.provider, rows);
	}

	const lines: string[] = ["Accounts in use by this session", ""];

	if (routed.size === 0) {
		lines.push(line(ROW_INDENT, "No provider has routed a request in this session yet."), "");
	}

	for (const [provider, rows] of routed) {
		const row = rows.find(candidate => candidate.activeForSession) ?? rows[0]!;
		const annotations = roles.get(provider) ?? [];
		lines.push(
			line(
				ROW_INDENT,
				cell(row.providerLabel, PROVIDER_COLUMN, true),
				cell(row.name ?? NO_NAME_PLACEHOLDER, NAME_COLUMN, true),
				annotations.join(" · "),
			),
		);

		// An unnamed row shows `(no name set)` where its label would go, so the label ladder's
		// answer moves down here — otherwise the block would name the provider and nothing else.
		const identity = [
			...(row.name ? [] : [accountDisplayLabel(row)]),
			...accountIdentityDetail(row),
			// Trails the identity here rather than leading it as on the card: this block already
			// spends its first column on the provider, so the plan reads as the last qualifier of
			// the account rather than competing with the name.
			...(row.planTier ? [row.planTier] : []),
		];
		if (identity.length > 0) {
			lines.push(line(DETAIL_INDENT, cell(identity.join(" · "), TRUNCATE_LENGTHS.CONTENT)));
		}

		const rotated = pinnedButRotated(inventory, provider);
		if (rotated) lines.push(...divergenceLines(provider, rotated.pinned, now));

		lines.push(...usageLines(row, now));

		if (row.health === "failed" && row.healthReason) {
			lines.push(line(DETAIL_INDENT, cell(row.healthReason, TRUNCATE_LENGTHS.CONTENT)));
		}
		if (!rotated && row.blockedUntilMs !== undefined && row.blockedUntilMs > now) {
			const unblocks = formatDurationCoarse(row.blockedUntilMs - now);
			lines.push(line(DETAIL_INDENT, `rate limited · ${unblocks} until it unblocks`));
		}
		if (!row.name) lines.push(line(DETAIL_INDENT, NAME_HINT));

		lines.push("");
	}

	const footer = `${routed.size} of ${inventory.providers.length} providers in use`;
	lines.push(line(ROW_INDENT, `${footer} · /providers to manage accounts`));
	return lines;
}
