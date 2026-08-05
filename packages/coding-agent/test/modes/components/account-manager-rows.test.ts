/**
 * Wording suite for the account manager's row shaping.
 *
 * These are the contracts a reader of the card depends on that the card's geometry cannot prove:
 * which providers the sidebar offers and in what order, what survives from a hostile upstream
 * string, and how a window label that arrives as prose is kept from eating the row. The card's
 * own suite drives the component; this one pins the text.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
	accountHeadLine,
	accountNoticeLines,
	accountUsageLines,
	buildSidebarEntries,
	providerHeaderLine,
	sidebarSummaryLine,
} from "@veyyon/coding-agent/modes/components/account-manager-rows";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { AccountInventory, AccountRow } from "@veyyon/coding-agent/session/account-inventory";

/** Fixed clock, so a countdown in an expectation is an exact string rather than a window. */
const NOW = 1_760_000_000_000;

beforeAll(async () => {
	await initTheme();
});

function account(provider: string, credentialId: number, overrides: Partial<AccountRow> = {}): AccountRow {
	return {
		provider,
		providerLabel: provider,
		credentialId,
		type: "oauth",
		usage: [],
		activeForSession: false,
		pinnedForSession: false,
		...overrides,
	};
}

function inventory(groups: Array<{ provider: string; label: string; rows: AccountRow[] }>): AccountInventory {
	const rows = groups.flatMap(group => group.rows);
	return {
		providers: groups,
		totalAccounts: rows.length,
		unhealthyCount: rows.filter(row => row.health === "failed").length,
	};
}

describe("buildSidebarEntries", () => {
	/**
	 * Locks out a sidebar built from stored credentials alone. That version can only list
	 * providers you already signed into, so `a` could never add the FIRST account for a provider
	 * and a new login would have to be started from somewhere else entirely. It locks out the
	 * reverse omission too: an api-key or env-var provider holds real credentials without
	 * offering an OAuth login, and dropping it would hide accounts that exist.
	 */
	test("offers every login provider and every provider holding credentials", () => {
		const entries = buildSidebarEntries(
			inventory([
				{ provider: "anthropic", label: "Anthropic", rows: [account("anthropic", 1)] },
				{ provider: "copilot", label: "GitHub Copilot", rows: [account("copilot", 2)] },
			]),
			[
				{ id: "anthropic", label: "Anthropic" },
				{ id: "xai", label: "xAI" },
				{ id: "groq", label: "Groq" },
			],
		);

		expect(entries.map(entry => `${entry.label}:${entry.annotation}`)).toEqual([
			"Anthropic:1",
			"GitHub Copilot:1",
			"Groq:—",
			"xAI:—",
		]);
	});

	/**
	 * Locks out a sidebar that buries a broken provider. The count alone cannot say that one of
	 * three Anthropic accounts stopped working, so the entry carries the flag that makes the
	 * card print a warning mark next to the number.
	 */
	test("flags a provider holding a failed credential", () => {
		const entries = buildSidebarEntries(
			inventory([
				{
					provider: "anthropic",
					label: "Anthropic",
					rows: [account("anthropic", 1), account("anthropic", 2, { health: "failed" })],
				},
				{ provider: "openai-codex", label: "OpenAI Codex", rows: [account("openai-codex", 3)] },
			]),
			[],
		);

		expect(entries.map(entry => ({ label: entry.label, failure: entry.hasFailure }))).toEqual([
			{ label: "Anthropic", failure: true },
			{ label: "OpenAI Codex", failure: false },
		]);
	});
});

describe("account row wording", () => {
	/**
	 * Locks out the plural bug an unpluralized count leaves behind: two broken credentials used
	 * to read "2 needs attention" in the one line a user reads before deciding whether anything
	 * is wrong.
	 */
	test("agrees in number with the count it reports", () => {
		const one = [account("anthropic", 1, { health: "failed" }), account("anthropic", 2)];
		const two = [account("anthropic", 1, { health: "failed" }), account("anthropic", 2, { health: "failed" })];

		expect(providerHeaderLine("Anthropic", one)).toBe("Anthropic · 2 accounts · 1 needs attention");
		expect(providerHeaderLine("Anthropic", two)).toBe("Anthropic · 2 accounts · 2 need attention");
		expect(providerHeaderLine("xAI", [])).toBe("xAI · no accounts yet");
		expect(sidebarSummaryLine(inventory([{ provider: "a", label: "A", rows: one }]))).toBe("2 accounts · 1 error");
	});

	/**
	 * Locks out an upstream failure body tearing the card open. OAuth error text arrives from the
	 * network and routinely carries tabs and newlines; rendered raw into a bordered row it pushes
	 * the right border off and leaves the rest of the frame misaligned.
	 */
	test("collapses tabs and newlines in an upstream failure reason to one row", () => {
		const lines = accountNoticeLines(
			account("anthropic", 1, {
				health: "failed",
				healthReason: "invalid_grant:\n\trefresh token revoked\r\nre-run /login",
			}),
			Date.now(),
		);

		expect(lines).toEqual(["invalid_grant: refresh token revoked re-run /login"]);
	});

	/**
	 * Locks out a prose window label pushing the usage bar out of the pane. Anthropic names its
	 * windows in sentences, so an unclamped label ("Claude 7 Day (Fable)") shifts the bar and the
	 * reset text right until they fall off the card. The clamp matches `/account status` so the
	 * same window reads the same way on both surfaces.
	 */
	test("clamps a prose usage-window label so the bar stays put", () => {
		const now = Date.now();
		const lines = accountUsageLines(
			account("anthropic", 1, {
				usage: [
					{ label: "5h", usedFraction: 0.7, resetsAtMs: now + 2 * 60 * 60 * 1000 },
					{ label: "Claude 7 Day (Fable)", usedFraction: 0.34 },
				],
			}),
			now,
		).map(line => stripVTControlCharacters(line));

		expect(lines[0]).toBe("5h    [███████░░░] 70%   resets in 2h");
		expect(lines[1]?.slice(0, 14)).toBe("Claude 7 Da…  ");
		expect(lines[1]).toBe("Claude 7 Da…  [███░░░░░░░] 34%");
	});
});

describe("the routing tag reports both facts", () => {
	/**
	 * The bug this locks out was found by walking the card as a user. Pressing `enter` on the
	 * account ALREADY serving the session recorded the pin and left the card byte-identical, because
	 * `activeForSession` owned the tag outright and never mentioned the pin. The host's confirmation
	 * goes to the transcript, which is behind this fullscreen card, so the row is the only place
	 * feedback can land: a primary action with no visible effect reads as a broken key.
	 */
	test("a serving account that was pinned says both", () => {
		expect(
			accountHeadLine(account("anthropic", 1, { activeForSession: true, pinnedForSession: true }), NOW).tag,
		).toBe("this session · pinned");
	});

	/** Serving by ordinary routing, with no pin, must NOT claim the user chose it. */
	test("a serving account that was not pinned says only that it is serving", () => {
		expect(accountHeadLine(account("anthropic", 1, { activeForSession: true }), NOW).tag).toBe("this session");
	});

	/**
	 * A pin whose account is not serving is the rotation case, and it must stay distinguishable from
	 * both of the above: this is the row the divergence banner is talking about.
	 */
	test("a pinned account that is not serving says only that it is pinned", () => {
		expect(accountHeadLine(account("anthropic", 1, { pinnedForSession: true }), NOW).tag).toBe("pinned");
	});
});
