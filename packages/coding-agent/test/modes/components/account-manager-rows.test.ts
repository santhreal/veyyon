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
		activeIsPrediction: false,
		selectedForProvider: false,
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
	 * Locks out a prose window label pushing the usage bar out of the pane, AND locks in that every
	 * bar of one account starts in the same column.
	 *
	 * Anthropic names its windows in sentences and Antigravity qualifies three same-named daily
	 * counters, so a fixed 8-column gutter either truncated the label into uselessness ("Claude 7…")
	 * or let a long one shove the bar off the card. The column is sized against THIS account's own
	 * labels: a label up to `USAGE_WINDOW_LABEL_MAX` survives whole, the short label beside it pads
	 * out to meet it, and only a label past the clamp is truncated.
	 */
	test("sizes the label gutter to the account's own labels and clamps past the maximum", () => {
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

		// 20 characters, exactly the clamp: rendered in full, never abbreviated.
		expect(lines[1]).toBe("Claude 7 Day (Fable) [███▍░░░░░░] 34%");
		// The short label pads to the same column, so the two bars line up.
		expect(lines[0]).toBe("5h                   [███████░░░] 70%   resets in 2h");
		expect(lines[0]?.indexOf("[")).toBe(lines[1]?.indexOf("[") ?? -1);
	});

	/** Past the clamp the label truncates rather than pushing the bar off the card. */
	test("truncates a label longer than the clamp", () => {
		const now = Date.now();
		const lines = accountUsageLines(
			account("anthropic", 1, {
				usage: [{ label: "Claude 7 Day (Fable Preview)", usedFraction: 0.34 }],
			}),
			now,
		).map(line => stripVTControlCharacters(line));

		expect(lines[0]).toBe("Claude 7 Day (Fable… [███▍░░░░░░] 34%");
	});
});

describe("the routing tag reports both facts", () => {
	/**
	 * The bug this locks out was found by walking the card as a user. Pressing `enter` on the
	 * account ALREADY serving the session recorded the choice and left the card byte-identical,
	 * because `activeForSession` owned the tag outright and never mentioned the choice. The host's
	 * confirmation goes to the transcript, which is behind this fullscreen card, so the row is the
	 * only place feedback can land: a primary action with no visible effect reads as a broken key.
	 */
	test("a serving account the user chose says both", () => {
		expect(
			accountHeadLine(account("anthropic", 1, { activeForSession: true, selectedForProvider: true }), NOW).tag,
		).toBe("serving · your choice");
	});

	/** Serving by ordinary routing, with no choice recorded, must NOT claim the user picked it. */
	test("a serving account nobody chose says only that it is serving", () => {
		expect(accountHeadLine(account("anthropic", 1, { activeForSession: true }), NOW).tag).toBe("serving");
	});

	/**
	 * A chosen account that is not serving is the rotation case, and it must stay distinguishable
	 * from both of the above: this is the row the divergence banner is talking about.
	 */
	test("a chosen account that is not serving says only that it is the choice", () => {
		expect(accountHeadLine(account("anthropic", 1, { selectedForProvider: true }), NOW).tag).toBe("your choice");
	});

	/**
	 * The tag never says "session". The choice outlives the session and the profile, so a word
	 * that scopes it to this run misdescribes what pressing enter did — which was the whole defect
	 * behind replacing the session pin. Enumerated over every reachable tag state rather than the
	 * one that regressed, so a future wording change cannot reintroduce the scope claim on a
	 * branch this file did not happen to name.
	 */
	test("no tag state claims the choice is session-scoped", () => {
		const states: Partial<AccountRow>[] = [
			{ activeForSession: true, selectedForProvider: true },
			{ activeForSession: true },
			{ selectedForProvider: true },
			{ blockedUntilMs: NOW + 60_000 },
			{ health: "failed" },
			{},
		];
		for (const state of states) {
			const tag = accountHeadLine(account("anthropic", 1, state), NOW).tag;
			expect(tag).not.toContain("session");
			expect(tag).not.toContain("pinned");
		}
	});
});

describe("usage windows line up under the labels providers actually send", () => {
	/**
	 * The bug this locks out shipped past a full synthetic suite and only appeared against a real
	 * store. The label column was 4 wide, which fits the `5h` / `7d` shorthand a fixture invents and
	 * NOTHING a provider returns: Anthropic sends `5 Hour` and `7 Day`, Antigravity `Daily`, Codex
	 * `7 days`. At 4 the pad was a no-op, so the bar butted straight against the label
	 * (`5 Hour[████░░░░░░]`) and two windows whose labels differ in length started their bars in
	 * different columns. Real labels are the fixture here, deliberately.
	 */
	test("keeps one bar column across real Anthropic window labels", () => {
		const lines = accountUsageLines(
			account("anthropic", 1, {
				usage: [
					{ label: "5 Hour", usedFraction: 0.36, resetsAtMs: NOW + 4 * 60 * 60_000 },
					{ label: "7 Day", usedFraction: 0.4, resetsAtMs: NOW + 2 * 24 * 60 * 60_000 },
				],
			}),
			NOW,
		).map(line => stripVTControlCharacters(line));

		expect(lines[0]).toBe("5 Hour  [███▋░░░░░░] 36%   resets in 4h");
		expect(lines[1]).toBe("7 Day   [████░░░░░░] 40%   resets in 2d");
		// The load-bearing assertion: both bars open in the same column.
		expect(lines[0]?.indexOf("[")).toBe(lines[1]?.indexOf("["));
	});

	/** A label always gets at least one space before its bar, however long it clips to. */
	test("never lets a label touch its bar", () => {
		for (const label of ["Daily", "7 days", "Usage window", "Claude 7 Day (Fable)"]) {
			const [rendered] = accountUsageLines(
				account("anthropic", 1, { usage: [{ label, usedFraction: 0.1 }] }),
				NOW,
			).map(line => stripVTControlCharacters(line));
			expect(rendered).not.toMatch(/\S\[/);
		}
	});
});
