/** The inline `/account status` block: which account each provider is serving this session with. clients (`runtime.output`), and the two used to be able to disagree. Taking an */
import { replaceTabs, truncateToWidth } from "@veyyon/tui";
import { sanitizeText } from "@veyyon/utils";
import {
	type AccountInventory,
	type AccountRow,
	accountDisplayLabel,
	accountIdentityDetail,
	activeSessionAccounts,
	credentialStateNote,
	selectedButRotated,
} from "../../session/account-inventory";
import { TRUNCATE_LENGTHS } from "../../tools/render-utils";
import { formatDurationCoarse, formatUsageWindowLine, usageWindowLabelColumn } from "./format";

/** Left margin of every account row, matching the other inline report blocks. */
const ROW_INDENT = "  ";
/** Width of the provider column, wide enough for the longest provider label plus a gap. */
const PROVIDER_COLUMN = 19;
/** Width of the account-name column, before the role annotations. */
const NAME_COLUMN = 28;
/** Continuation lines hang under the account name, not under the provider. */
const DETAIL_INDENT = " ".repeat(ROW_INDENT.length + PROVIDER_COLUMN);
/** Bar cells. Narrower than the `/usage` report's default: this block carries three columns. */
const USAGE_BAR_WIDTH = 10;

/** Shown in the NAME column when the user never named the account. */
export const NO_NAME_PLACEHOLDER = "(no name set)";
/** The invitation that follows an unnamed account. */
export const NAME_HINT = "/account name <text>";

/** Search-provider preference → the credential providers that preference spends. Only the search backends that route through a stored ACCOUNT are listed, because only those can */
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

/** Which session roles each provider serves, as the block annotates them. The annotation is the answer to "why is this provider in my session at all", and it is per */
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

/** `5 Hour   [███████▏░░] 71%   resets in 2h` for one usage window. */
function usageLines(row: AccountRow, now: number): string[] {
	const lines: string[] = [];
	const labels = row.usage.map(window => sanitizeText(window.label));
	const column = usageWindowLabelColumn(labels);
	for (const [index, window] of row.usage.entries()) {
		const resets =
			window.resetsAtMs !== undefined && window.resetsAtMs > now
				? `   resets in ${formatDurationCoarse(window.resetsAtMs - now)}`
				: undefined;
		lines.push(
			line(
				DETAIL_INDENT,
				formatUsageWindowLine(labels[index] ?? "", window.usedFraction, USAGE_BAR_WIDTH, resets, column),
			),
		);
	}
	return lines;
}

/** Why the chosen account stopped serving, in the words the store actually has for it. */
function rotationReason(chosen: AccountRow, now: number): string {
	if (chosen.blockedUntilMs !== undefined && chosen.blockedUntilMs > now) return "usage limit";
	if (chosen.healthReason) return cell(chosen.healthReason, TRUNCATE_LENGTHS.CONTENT);
	return "unavailable";
}

/** The two lines a rotated choice gets, naming the account the user picked and what replaced it. This is the case the surface exists for. The account serving the session is NOT the one they */
function divergenceLines(provider: string, chosen: AccountRow, now: number): string[] {
	const chosenLabel = cell(accountDisplayLabel(chosen), TRUNCATE_LENGTHS.TITLE);
	const unblocks =
		chosen.blockedUntilMs !== undefined && chosen.blockedUntilMs > now
			? ` · ${formatDurationCoarse(chosen.blockedUntilMs - now)} until it unblocks`
			: "";
	return [
		line(DETAIL_INDENT, `you chose ${chosenLabel}, rotated off it (${rotationReason(chosen, now)})`),
		line(DETAIL_INDENT, `/account use ${provider} ${chosenLabel} to switch back${unblocks}`),
	];
}

/** The `/account status` block: one account per provider this session actually routed to. The footer's denominator is the number of providers you hold accounts FOR, not the number */
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

		const rotated = selectedButRotated(inventory, provider);
		if (rotated) {
			const dl = divergenceLines(provider, rotated.chosen, now);
			for (let li = 0; li < dl.length; li++) lines.push(dl[li]!);
		}

		const ul = usageLines(row, now);
		for (let li = 0; li < ul.length; li++) lines.push(ul[li]!);

		if (row.health === "failed" && row.healthReason) {
			lines.push(line(DETAIL_INDENT, cell(row.healthReason, TRUNCATE_LENGTHS.CONTENT)));
		}
		if (!rotated && row.blockedUntilMs !== undefined && row.blockedUntilMs > now) {
			const unblocks = formatDurationCoarse(row.blockedUntilMs - now);
			lines.push(line(DETAIL_INDENT, `rate limited · ${unblocks} until it unblocks`));
		}
		// The same sentence the card prints, with this surface's own remedy: a text client has no
		// `a` key to press. The fact is one owner's, the offer is the surface's.
		const credential = credentialStateNote(row, now);
		if (credential) {
			lines.push(line(DETAIL_INDENT, `${credential} · /providers to sign in again`));
		}
		lines.push("");
	}

	// ONE hint for the whole block, not one per unnamed account. A real session routes several providers at once and almost none of them are named, so the per-row form printed the same
	const unnamed = Array.from(routed.values()).filter(
		rows => !(rows.find(r => r.activeForSession) ?? rows[0])?.name,
	).length;
	if (unnamed > 0) {
		lines.push(
			line(ROW_INDENT, `${unnamed === 1 ? "1 account has" : `${unnamed} accounts have`} no name · ${NAME_HINT}`),
			"",
		);
	}

	// A torn-down login is not an account "in use", so it has no block of its own here — but this is
	// the surface a user checks first, and saying nothing would leave the dead login discoverable only
	// by opening the manager on a hunch. One pointer, counted, in the same shape as the naming hint.
	const signedOut = inventory.providers.filter(entry => entry.disabledCause !== undefined);
	if (signedOut.length > 0) {
		const which = signedOut.map(entry => entry.label).join(", ");
		lines.push(
			line(
				ROW_INDENT,
				`${signedOut.length === 1 ? "1 provider has" : `${signedOut.length} providers have`} a signed-out login (${which}) · /providers to sign in again`,
			),
			"",
		);
	}

	const footer = `${routed.size} of ${inventory.providers.length} providers in use`;
	lines.push(line(ROW_INDENT, `${footer} · /providers to manage accounts`));
	return lines;
}
