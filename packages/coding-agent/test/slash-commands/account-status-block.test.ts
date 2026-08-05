/**
 * The `/account status` block, asserted byte for byte.
 *
 * WHY THIS SUITE EXISTS. This block is the answer to "which account am I spending", and every part
 * of it is load-bearing in a way a semantic assertion would not catch: the three columns line up by
 * padding, the footer counts providers rather than accounts, an unnamed row must invite a name
 * instead of showing a blank, and a pin that was rotated off must be REPORTED rather than replaced
 * silently by whatever is serving now. Exact bytes are asserted because the alignment IS the
 * feature: a shifted column turns a three-column report into unreadable prose.
 *
 * ANSI is stripped before comparing. `renderAsciiBar` shimmers its bar through the active theme, so
 * the escape sequences move with the clock while the visible text does not — the visible text is
 * what a reader sees and what these tests pin.
 */
import { describe, expect, it } from "bun:test";
import type { AccountInventory, AccountRow } from "@veyyon/coding-agent/session/account-inventory";
import {
	accountRoleAnnotations,
	NAME_HINT,
	NO_NAME_PLACEHOLDER,
	renderAccountStatus,
	WEB_SEARCH_CREDENTIAL_PROVIDERS,
} from "@veyyon/coding-agent/slash-commands/helpers/account-status";
import { stripAnsi } from "@veyyon/utils";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function row(
	overrides: Partial<AccountRow> & Pick<AccountRow, "provider" | "providerLabel" | "credentialId">,
): AccountRow {
	return {
		type: "oauth",
		usage: [],
		activeForSession: false,
		pinnedForSession: false,
		...overrides,
	};
}

/** Providers are listed in the order the inventory holds them, which is alphabetical by label. */
function inventory(...providers: Array<{ provider: string; label: string; rows: AccountRow[] }>): AccountInventory {
	return {
		providers,
		totalAccounts: providers.reduce((sum, entry) => sum + entry.rows.length, 0),
		unhealthyCount: providers.reduce(
			(sum, entry) => sum + entry.rows.filter(entry2 => entry2.health === "failed").length,
			0,
		),
	};
}

function render(inv: AccountInventory, roles: ReadonlyMap<string, readonly string[]> = new Map()): string {
	return renderAccountStatus(inv, NOW, roles)
		.map(line => stripAnsi(line))
		.join("\n");
}

const anthropicWork = row({
	provider: "anthropic",
	providerLabel: "Anthropic",
	credentialId: 1,
	name: "work",
	email: "first@example.com",
	orgName: "Example Org",
	activeForSession: true,
	usage: [
		{ label: "5h", usedFraction: 0.71, resetsAtMs: NOW + 2 * HOUR + 14 * 60_000 },
		{ label: "7d", usedFraction: 0.34, resetsAtMs: NOW + 4 * DAY },
	],
});

const codexMain = row({
	provider: "openai-codex",
	providerLabel: "Openai Codex",
	credentialId: 2,
	name: "codex-main",
	email: "first@example.com",
	activeForSession: true,
	usage: [{ label: "5h", usedFraction: 0.44, resetsAtMs: NOW + 68 * 60_000 }],
});

const geminiPersonal = row({
	provider: "google-gemini-cli",
	providerLabel: "Google Gemini Cli",
	credentialId: 3,
	email: "second@example.com",
	projectId: "example-project",
	activeForSession: true,
});

const xaiIdle = row({ provider: "xai", providerLabel: "Xai", credentialId: 4 });

const fullInventory = inventory(
	{ provider: "anthropic", label: "Anthropic", rows: [anthropicWork] },
	{ provider: "google-gemini-cli", label: "Google Gemini Cli", rows: [geminiPersonal] },
	{ provider: "openai-codex", label: "Openai Codex", rows: [codexMain] },
	{ provider: "xai", label: "Xai", rows: [xaiIdle] },
);

const fullRoles = accountRoleAnnotations({
	mainModel: { provider: "anthropic", id: "opus-5" },
	subagentProviders: ["openai-codex"],
	webSearchPreference: "gemini",
});

describe("the /account status block reports the accounts in use", () => {
	/**
	 * The whole block, byte for byte: three routed providers with their roles, identity lines,
	 * usage bars and the footer. This is the assertion that fails on a column width change, a
	 * separator change, a reordered line inside a block, or a lost blank line — none of which a
	 * "contains the email" check would notice.
	 */
	it("renders every routed provider in three aligned columns", () => {
		expect(render(fullInventory, fullRoles)).toBe(
			[
				"Accounts in use by this session",
				"",
				"  Anthropic          work                        main model  (opus-5)",
				"                     first@example.com · org Example Org",
				"                     5h      [███████░░░] 71%   resets in 2h",
				"                     7d      [███░░░░░░░] 34%   resets in 4d",
				"",
				"  Google Gemini Cli  (no name set)               web search",
				"                     second@example.com · project example-project",
				"",
				"  Openai Codex       codex-main                  subagents",
				"                     first@example.com",
				"                     5h      [████░░░░░░] 44%   resets in 1h",
				"",
				// ONE hint for the block. The per-row form printed this sentence once per unnamed
				// account, which in a real eight-provider session meant seven repetitions of it.
				"  1 account has no name · /account name <text>",
				"",
				"  3 of 4 providers in use · /providers to manage accounts",
			].join("\n"),
		);
	});

	/**
	 * A provider whose credentials the session never routed to is ABSENT from the block. The block
	 * answers "in use by this session", and listing every configured provider was the defect the
	 * old provider list had: it showed six rows while one account was being spent, so it could not
	 * be used to answer the only question a user asks it.
	 */
	it("omits a provider the session never routed to", () => {
		const rendered = render(fullInventory, fullRoles);

		expect(rendered).not.toContain("Xai");
		expect(rendered).not.toContain("xai");
	});

	/**
	 * The footer's numerator counts ROUTED providers and its denominator counts providers you hold
	 * accounts for. Both halves are asserted from the same fixture with only the routing changed, so
	 * a footer that counted accounts (five here) or configured providers (four) fails.
	 */
	it("counts routed providers against credentialed providers in the footer", () => {
		const twoAccountsOneRouted = inventory(
			{
				provider: "anthropic",
				label: "Anthropic",
				rows: [
					anthropicWork,
					row({ provider: "anthropic", providerLabel: "Anthropic", credentialId: 9, name: "personal" }),
				],
			},
			{
				provider: "google-gemini-cli",
				label: "Google Gemini Cli",
				rows: [row({ ...geminiPersonal, activeForSession: false })],
			},
			{ provider: "openai-codex", label: "Openai Codex", rows: [row({ ...codexMain, activeForSession: false })] },
			{ provider: "xai", label: "Xai", rows: [xaiIdle] },
		);

		expect(render(twoAccountsOneRouted).split("\n").at(-1)).toBe(
			"  1 of 4 providers in use · /providers to manage accounts",
		);
	});

	/**
	 * An account the user never named says so, and the block offers the command ONCE.
	 *
	 * Rendering the email in the name column instead would be indistinguishable from a named account
	 * called after the email, so the placeholder is what makes "you have not named this" legible, and
	 * the account's own identity moves to the line below rather than disappearing. The hint lives at
	 * the foot of the block rather than under each row: a real session routes several unnamed
	 * providers, and repeating the sentence per row buried the accounts between copies of it.
	 */
	it("marks an unnamed account and offers the naming command once", () => {
		const rendered = render(
			inventory({ provider: "google-gemini-cli", label: "Google Gemini Cli", rows: [geminiPersonal] }),
		);

		expect(rendered).toContain(`  Google Gemini Cli  ${NO_NAME_PLACEHOLDER}`);
		expect(rendered).toContain("                     second@example.com · project example-project");
		expect(rendered).toContain(`  1 account has no name · ${NAME_HINT}`);
		// Not under the row: the indented per-row form is what this replaced.
		expect(rendered).not.toContain(`                     ${NAME_HINT}`);
	});

	/**
	 * The hint counts the accounts it applies to, and pluralises. A block saying "1 accounts" over a
	 * list of two is the kind of detail that makes a surface feel unfinished.
	 */
	it("counts and pluralises the unnamed accounts in the single hint", () => {
		const rendered = render(
			inventory(
				{ provider: "google-gemini-cli", label: "Google Gemini Cli", rows: [geminiPersonal] },
				{ provider: "xai", label: "Xai", rows: [row({ ...xaiIdle, activeForSession: true, name: undefined })] },
			),
		);

		expect(rendered).toContain(`  2 accounts have no name · ${NAME_HINT}`);
	});

	/**
	 * A named account shows the NAME in the name column and keeps the email on the identity line, so
	 * the name never costs the reader the ability to tell which login it stands for. The naming hint
	 * must be gone: repeating it under an account that already has a name reads as a failure.
	 */
	it("shows a named account with its email underneath and no naming hint", () => {
		const rendered = render(inventory({ provider: "anthropic", label: "Anthropic", rows: [anthropicWork] }));

		expect(rendered).toContain("  Anthropic          work");
		expect(rendered).toContain("                     first@example.com · org Example Org");
		expect(rendered).not.toContain(NAME_HINT);
		expect(rendered).not.toContain(NO_NAME_PLACEHOLDER);
	});
});

describe("a pin that was rotated off is reported, never replaced", () => {
	const pinnedWork = row({
		provider: "anthropic",
		providerLabel: "Anthropic",
		credentialId: 1,
		name: "work",
		email: "first@example.com",
		pinnedForSession: true,
		blockedUntilMs: NOW + 2 * HOUR + 14 * 60_000,
	});
	const servingPersonal = row({
		provider: "anthropic",
		providerLabel: "Anthropic",
		credentialId: 2,
		name: "personal",
		email: "second@example.com",
		activeForSession: true,
	});
	const rotated = inventory({ provider: "anthropic", label: "Anthropic", rows: [pinnedWork, servingPersonal] });

	/**
	 * THE CASE THIS SURFACE EXISTS FOR. The account serving the session is not the one the user
	 * pinned, and the old provider list showed only "logged in" — so a rate-limit rotation looked
	 * exactly like a deliberate choice. The block names the pin, names why it stopped, and says how
	 * to get back to it; the substitute is shown as what is serving, never as what was chosen.
	 */
	it("names the pin, the reason and the way back", () => {
		expect(render(rotated)).toBe(
			[
				"Accounts in use by this session",
				"",
				"  Anthropic          personal",
				"                     second@example.com",
				"                     pinned to work, rotated off it (usage limit)",
				"                     /account switch anthropic to re-pin work · 2h until it unblocks",
				"",
				"  1 of 1 providers in use · /providers to manage accounts",
			].join("\n"),
		);
	});

	/**
	 * One block per provider even when two rows of it are "in use" — the pinned one and the one
	 * actually serving. `activeSessionAccounts` returns both, and printing both would tell the user
	 * they are spending two Anthropic accounts at once, which is false.
	 */
	it("renders one block for the provider, not one per involved row", () => {
		const lines = render(rotated).split("\n");

		expect(lines.filter(line => line.startsWith("  Anthropic"))).toHaveLength(1);
	});

	/**
	 * A pin that is neither rate-limit blocked nor failed still has to explain itself. It is
	 * reachable when the pinned credential was superseded rather than throttled, and "unavailable"
	 * is the honest word for it — inventing "usage limit" there would name a limit that never fired.
	 */
	it("says unavailable when the pin was neither blocked nor failed", () => {
		const { blockedUntilMs: _dropped, ...unblockedPin } = pinnedWork;
		const superseded = inventory({
			provider: "anthropic",
			label: "Anthropic",
			rows: [unblockedPin, servingPersonal],
		});

		const lines = render(superseded).split("\n");

		expect(lines).toContain("                     pinned to work, rotated off it (unavailable)");
		expect(lines).toContain("                     /account switch anthropic to re-pin work");
	});

	/**
	 * The upstream failure text is what the pin's own probe said, printed verbatim rather than
	 * flattened into "unavailable": `invalid_grant: refresh token revoked` is the difference between
	 * a user re-logging in and a user waiting for a limit that will never lift.
	 */
	it("prints the upstream reason when the pin failed its probe", () => {
		const failedPin = row({ ...pinnedWork, health: "failed", healthReason: "invalid_grant: refresh token revoked" });
		const { blockedUntilMs: _dropped, ...unblocked } = failedPin;
		const rendered = render(
			inventory({ provider: "anthropic", label: "Anthropic", rows: [unblocked, servingPersonal] }),
		);

		expect(rendered).toContain("pinned to work, rotated off it (invalid_grant: refresh token revoked)");
	});
});

describe("role annotations name why a provider is in the session", () => {
	/**
	 * The main model carries its id because "main model" alone does not distinguish the model the
	 * user picked from a role that happens to share a provider.
	 */
	it("annotates the main model with the model id", () => {
		expect(accountRoleAnnotations({ mainModel: { provider: "anthropic", id: "opus-5" } }).get("anthropic")).toEqual([
			"main model  (opus-5)",
		]);
	});

	/**
	 * One provider can serve several roles, and each role is said once. A provider repeated in the
	 * sources (main model and subagent inheritance both landing on it) must not read
	 * "subagents · subagents".
	 */
	it("collects several roles per provider without repeating one", () => {
		const roles = accountRoleAnnotations({
			mainModel: { provider: "anthropic", id: "opus-5" },
			subagentProviders: ["anthropic", "anthropic"],
			webSearchPreference: "anthropic",
		});

		expect(roles.get("anthropic")).toEqual(["main model  (opus-5)", "subagents", "web search"]);
	});

	/**
	 * `auto` web search resolves at call time across every engine, so no single provider can be
	 * annotated for it. Claiming one would tell the user an account is spending on search when the
	 * chain may never reach it.
	 */
	it("annotates no provider for an auto web-search preference", () => {
		expect(accountRoleAnnotations({ webSearchPreference: "auto" }).size).toBe(0);
	});

	/**
	 * A search preference that spends an API key or a credential-free scrape has no account to
	 * annotate. Only the OAuth-backed engines appear in the table, and that is what keeps an
	 * API-key engine from being drawn as somebody's logged-in account.
	 */
	it("annotates only the search engines that spend a stored account", () => {
		expect(accountRoleAnnotations({ webSearchPreference: "brave" }).size).toBe(0);
		expect(WEB_SEARCH_CREDENTIAL_PROVIDERS.gemini).toEqual(["google-gemini-cli", "google-antigravity"]);
	});
});

describe("the status block points at a signed-out login", () => {
	/**
	 * A torn-down login is not an account "in use", so it gets no block of its own — but this is the
	 * surface a user checks first, and saying nothing would leave a dead login discoverable only by
	 * opening the manager on a hunch. The pointer names the provider so the reader knows where to go.
	 */
	it("names the provider whose login was signed out", () => {
		const withDeadLogin: AccountInventory = {
			...fullInventory,
			providers: [
				...fullInventory.providers,
				{ provider: "kimi-code", label: "Kimi Code", rows: [], disabledCause: "oauth refresh failed: revoked" },
			],
		};

		expect(render(withDeadLogin, fullRoles)).toContain(
			"  1 provider has a signed-out login (Kimi Code) · /providers to sign in again",
		);
	});

	/** Two dead logins pluralise and list both, so the count never disagrees with the names. */
	it("counts and lists several signed-out providers", () => {
		const withTwo: AccountInventory = {
			...fullInventory,
			providers: [
				...fullInventory.providers,
				{ provider: "kimi-code", label: "Kimi Code", rows: [], disabledCause: "oauth refresh failed: revoked" },
				{ provider: "cursor", label: "Cursor", rows: [], disabledCause: "oauth refresh failed: expired" },
			],
		};

		expect(render(withTwo, fullRoles)).toContain(
			"  2 providers have a signed-out login (Kimi Code, Cursor) · /providers to sign in again",
		);
	});

	/** No dead login, no pointer. A healthy session must not carry a line about signing in again. */
	it("says nothing about signed-out logins when there are none", () => {
		expect(render(fullInventory, fullRoles)).not.toContain("signed-out login");
	});
});
