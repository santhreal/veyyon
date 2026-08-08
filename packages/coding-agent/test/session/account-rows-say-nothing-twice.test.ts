/**
 * An account row must not spend its width restating what it already said, and must not carry a
 * warning about a healthy account.
 *
 * Both contracts here come from ONE live run of the account manager against a real credential
 * store, and neither was reachable from the synthetic fixtures the other suites use. A real
 * Anthropic personal workspace is auto-named `<login address>'s Organization`, so a real row
 * rendered `you@example.com · org you@example.com's Organization` and truncated. And
 * `checkCredentials` answers `ok: null` with a reason whenever no usage probe exists for a
 * provider, so the words `no usage probe configured for provider anthropic` appeared under every
 * healthy account, which reads as two broken logins.
 *
 * Both are cosmetic in the sense that nothing crashes, and neither is cosmetic in the sense that
 * matters: the first eats the column that tells two accounts apart, and the second tells a user
 * their working account is broken.
 */
import { describe, expect, test } from "bun:test";
import {
	accountNoticeLines,
	buildSidebarEntries,
	NO_ACCOUNTS_ANNOTATION,
	providerDisabledNote,
} from "@veyyon/coding-agent/modes/components/account-manager-rows";
import { type AccountRow, accountIdentityDetail } from "@veyyon/coding-agent/session/account-inventory";

const NOW = 1_760_000_000_000;
const HOUR = 60 * 60_000;

function row(overrides: Partial<AccountRow> = {}): AccountRow {
	return {
		provider: "anthropic",
		providerLabel: "Anthropic",
		credentialId: 7,
		type: "oauth",
		usage: [],
		activeForSession: false,
		selectedForProvider: false,
		...overrides,
	};
}

describe("an account row does not repeat itself", () => {
	/**
	 * The exact shape observed live: Anthropic derives a personal workspace name from the login
	 * address, so the org adds no information and costs the widest field on the row.
	 */
	test("drops an org name that merely restates the email", () => {
		expect(
			accountIdentityDetail(row({ email: "person@example.com", orgName: "person@example.com's Organization" })),
		).toEqual([]);
	});

	/** Case must not defeat it: the provider is free to normalise the address differently. */
	test("drops a restating org name regardless of case", () => {
		expect(
			accountIdentityDetail(row({ email: "Person@Example.com", orgName: "PERSON@EXAMPLE.COM's Organization" })),
		).toEqual([]);
	});

	/**
	 * The other half of the same contract, and the reason this is a substring rule rather than a
	 * blanket suppression: a real organisation name is the ONLY thing distinguishing two
	 * subscriptions that share one login, so it must survive.
	 */
	test("keeps a real org name that shares nothing with the email", () => {
		expect(accountIdentityDetail(row({ email: "person@example.com", orgName: "Example Org" }))).toEqual([
			"org Example Org",
		]);
	});

	/** With a chosen name the email moves onto the detail line, and the derived org still goes. */
	test("shows the email but not the derived org when the account is named", () => {
		expect(
			accountIdentityDetail(
				row({ name: "work", email: "person@example.com", orgName: "person@example.com's Organization" }),
			),
		).toEqual(["person@example.com"]);
	});

	/**
	 * An org id is a UUID: it identifies the subscription without describing it, so it earns a slot
	 * only when no name was recovered at all. Suppressing the derived NAME must not promote the id
	 * into the gap it left, or the row trades one useless field for another.
	 */
	test("does not fall through to the org id when a derived org name was dropped", () => {
		expect(
			accountIdentityDetail(
				row({ email: "person@example.com", orgName: "person@example.com's Organization", orgId: "org-7b1" }),
			),
		).toEqual([]);
	});
});

describe("an account row warns only about real problems", () => {
	/**
	 * `ok: null` means "not verifiable from here", and its reason is a sentence about Veyyon's own
	 * plumbing. A healthy account must carry no notice at all.
	 */
	test("says nothing for an unverifiable account with a diagnostic reason", () => {
		expect(
			accountNoticeLines(
				row({ health: "unverifiable", healthReason: "no usage probe configured for provider anthropic" }),
				NOW,
			),
		).toEqual([]);
	});

	/** A healthy probe result with no reason at all is silent for the same reason. */
	test("says nothing for a healthy account", () => {
		expect(accountNoticeLines(row({ health: "ok" }), NOW)).toEqual([]);
	});

	/**
	 * The contract this must not break while suppressing the noise: a genuinely failed credential
	 * prints the upstream words verbatim, because `invalid_grant: refresh token revoked` is the only
	 * thing that tells a user the grant died on the provider's side rather than locally.
	 */
	test("prints the upstream reason verbatim for a failed account", () => {
		expect(
			accountNoticeLines(row({ health: "failed", healthReason: "invalid_grant: refresh token revoked" }), NOW),
		).toEqual(["invalid_grant: refresh token revoked"]);
	});

	/** A rate-limit block is a real problem on an otherwise healthy account, so it still reports. */
	test("reports a live rate-limit block on a healthy account", () => {
		expect(accountNoticeLines(row({ health: "ok", blockedUntilMs: NOW + 2 * HOUR }), NOW)).toEqual([
			"rate limited · unblocks in 2h",
		]);
	});

	/** An expired block is not a problem, so it must not linger on the row. */
	test("says nothing once a block has expired", () => {
		expect(accountNoticeLines(row({ health: "ok", blockedUntilMs: NOW - 1 }), NOW)).toEqual([]);
	});
});

describe("a login torn down by a failed refresh is visible", () => {
	/**
	 * The silent logout in its final form, and the reason this note exists. `listAuthCredentials`
	 * filters disabled rows, so a provider whose refresh failed reads as one you never signed into:
	 * the user is told to log in, and never told that the login they had was thrown away or why. This
	 * was live in the author's own store — a kimi-code grant revoked upstream, invisible on every
	 * surface.
	 */
	test("names the provider and prints the upstream cause when a sibling still works", () => {
		expect(
			providerDisabledNote({
				disabledCause: "oauth refresh failed: invalid_grant: the grant is invalid",
				rows: [row()],
			}),
		).toEqual([
			"a previous login was signed out: oauth refresh failed: invalid_grant: the grant is invalid",
			"press a to sign in again",
		]);
	});

	/**
	 * The worse case reads differently on purpose: with no account left, "a previous login" would
	 * understate it. The provider cannot serve anything at all until you sign in again.
	 */
	test("says the provider itself is signed out when no account remains", () => {
		const [lead] = providerDisabledNote({ disabledCause: "oauth refresh failed: revoked", rows: [] });
		expect(lead).toBe("the login for this provider was signed out: oauth refresh failed: revoked");
	});

	/** No disable, no note. A healthy provider must not carry a warning. */
	test("says nothing when no login was torn down", () => {
		expect(providerDisabledNote({ rows: [row()] })).toEqual([]);
	});

	/**
	 * The sidebar mark has to fire for a torn-down login too, including when the provider has no rows
	 * left to carry a glyph of their own — otherwise the only thing pointing at the problem is a
	 * provider you have to already suspect.
	 */
	test("marks the provider in the sidebar even with no accounts left", () => {
		const [entry] = buildSidebarEntries(
			{
				providers: [
					{ provider: "kimi-code", label: "Kimi Code", rows: [], disabledCause: "oauth refresh failed: revoked" },
				],
				totalAccounts: 0,
				unhealthyCount: 0,
			},
			[{ id: "kimi-code", label: "Kimi Code" }],
		);

		expect(entry?.hasFailure).toBe(true);
		expect(entry?.annotation).toBe(NO_ACCOUNTS_ANNOTATION);
	});
});
