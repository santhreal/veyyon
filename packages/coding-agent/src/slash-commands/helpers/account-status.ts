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

const ROW_INDENT = "  ";
const PROVIDER_COLUMN = 19;
const NAME_COLUMN = 28;
const DETAIL_INDENT = " ".repeat(ROW_INDENT.length + PROVIDER_COLUMN);
const USAGE_BAR_WIDTH = 10;

export const NO_NAME_PLACEHOLDER = "(no name set)";
export const NAME_HINT = "/account name <text>";

export const WEB_SEARCH_CREDENTIAL_PROVIDERS: Readonly<Record<string, readonly string[]>> = {
	anthropic: ["anthropic"],
	codex: ["openai-codex"],
	gemini: ["google-gemini-cli", "google-antigravity"],
};

export interface AccountRoleSources {
	mainModel?: { provider: string; id: string };
	subagentProviders?: readonly string[];
	webSearchPreference?: string;
}

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
	for (const provider of WEB_SEARCH_CREDENTIAL_PROVIDERS[sources.webSearchPreference ?? ""] ?? []) {
		add(provider, "web search");
	}
	return roles;
}

function cell(text: string, width: number, pad = false): string {
	return truncateToWidth(replaceTabs(sanitizeText(text)), width, undefined, pad);
}

function line(...parts: string[]): string {
	return parts.join("").trimEnd();
}

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

function rotationReason(chosen: AccountRow, now: number): string {
	if (chosen.blockedUntilMs !== undefined && chosen.blockedUntilMs > now) return "usage limit";
	if (chosen.healthReason) return cell(chosen.healthReason, TRUNCATE_LENGTHS.CONTENT);
	return "unavailable";
}

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

		const identity = [
			...(row.name ? [] : [accountDisplayLabel(row)]),
			...accountIdentityDetail(row),
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
		const credential = credentialStateNote(row, now);
		if (credential) {
			lines.push(line(DETAIL_INDENT, `${credential} · /providers to sign in again`));
		}
		lines.push("");
	}

	const unnamed = Array.from(routed.values()).filter(
		rows => !(rows.find(r => r.activeForSession) ?? rows[0])?.name,
	).length;
	if (unnamed > 0) {
		lines.push(
			line(ROW_INDENT, `${unnamed === 1 ? "1 account has" : `${unnamed} accounts have`} no name · ${NAME_HINT}`),
			"",
		);
	}

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
