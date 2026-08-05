/**
 * Every usage bar must belong to the account it is drawn under.
 *
 * A provider answers one usage request with limits for SEVERAL accounts at once, so
 * `applyUsageReports` has to split one report across rows rather than hand the whole thing to
 * whichever row it looked at first. The hard case is two Anthropic subscriptions on one
 * login: same email, same account id, different org. Cross-attributing there tells a user
 * their personal Pro window is 94% consumed when it is their employer's Team pool that is,
 * which is a number they would act on.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore, type UsageLimit, type UsageReport } from "@veyyon/ai";
import { applyUsageReports, buildAccountInventory } from "@veyyon/coding-agent/session/account-inventory";

/**
 * Org-scoped identity is what keeps two credentials on one email as two rows, and the org gate
 * in the shared match predicate is exactly what this file tests, so the provider must be real.
 */
const ANTHROPIC = "anthropic";
const MULTI_ACCOUNT_PROVIDER = "unit-usage-multi";
const HOUR_MS = 60 * 60_000;
const RESETS_AT = 1_760_000_000_000;

function limitFor(id: string, scope: UsageLimit["scope"], usedFraction: number, label: string): UsageLimit {
	return {
		id,
		label,
		scope,
		window: { id: label, label, resetsAt: RESETS_AT },
		amount: { usedFraction, unit: "percent" },
	};
}

describe("applyUsageReports attributes limits per account", () => {
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		authStorage = new AuthStorage(store);
		await authStorage.reload();
	});

	afterEach(() => {
		store?.close();
		store = null;
		authStorage = null;
	});

	/**
	 * One report, two accounts, distinguished only by the account id on each limit's scope.
	 * Each row must collect its own column and nothing else — the failure this prevents is
	 * every row showing every window, which reads as one account with six bars.
	 */
	test("one report carrying limits for two accounts attaches each limit to its own row", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		await storage.set(MULTI_ACCOUNT_PROVIDER, [
			{
				type: "oauth",
				access: "access-one",
				refresh: "refresh-one",
				expires: Date.now() + HOUR_MS,
				accountId: "account-one",
				email: "one@example.com",
			},
			{
				type: "oauth",
				access: "access-two",
				refresh: "refresh-two",
				expires: Date.now() + HOUR_MS,
				accountId: "account-two",
				email: "two@example.com",
			},
		]);
		const report: UsageReport = {
			provider: MULTI_ACCOUNT_PROVIDER,
			fetchedAt: RESETS_AT - HOUR_MS,
			limits: [
				limitFor("one-5h", { provider: MULTI_ACCOUNT_PROVIDER, accountId: "account-one" }, 0.71, "5h"),
				limitFor("two-5h", { provider: MULTI_ACCOUNT_PROVIDER, accountId: "account-two" }, 0.18, "5h"),
				limitFor("two-7d", { provider: MULTI_ACCOUNT_PROVIDER, accountId: "account-two" }, 0.34, "7d"),
			],
		};

		const next = applyUsageReports(buildAccountInventory(storage), [report]);
		const rows = next.providers[0]?.rows ?? [];

		expect(rows.map(row => row.usage)).toEqual([
			[{ label: "5h", usedFraction: 0.71, resetsAtMs: RESETS_AT }],
			[
				{ label: "5h", usedFraction: 0.18, resetsAtMs: RESETS_AT },
				{ label: "7d", usedFraction: 0.34, resetsAtMs: RESETS_AT },
			],
		]);
	});

	/**
	 * Two Anthropic subscriptions on one login. The email matches BOTH rows, so only the org
	 * gate keeps them apart; a match rule that fell back to email whenever the org agreed —
	 * or that ignored orgs entirely — would give each row the other's numbers as well as its
	 * own, and the two would show identical bars.
	 */
	test("two subscriptions sharing an email do not claim each other's limits", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const sharedEmail = "shared@example.com";
		await storage.set(ANTHROPIC, [
			{
				type: "oauth",
				access: "access-team",
				refresh: "refresh-team",
				expires: Date.now() + HOUR_MS,
				accountId: "account-shared",
				email: sharedEmail,
				orgId: "org-team",
				orgName: "Example Org",
			},
			{
				type: "oauth",
				access: "access-personal",
				refresh: "refresh-personal",
				expires: Date.now() + HOUR_MS,
				accountId: "account-shared",
				email: sharedEmail,
				orgId: "org-personal",
				orgName: "Personal",
			},
		]);
		const teamReport: UsageReport = {
			provider: ANTHROPIC,
			fetchedAt: RESETS_AT - HOUR_MS,
			metadata: { email: sharedEmail, accountId: "account-shared", orgId: "org-team" },
			limits: [limitFor("team-5h", { provider: ANTHROPIC }, 0.94, "5h")],
		};
		const personalReport: UsageReport = {
			provider: ANTHROPIC,
			fetchedAt: RESETS_AT - HOUR_MS,
			metadata: { email: sharedEmail, accountId: "account-shared", orgId: "org-personal" },
			limits: [limitFor("personal-5h", { provider: ANTHROPIC }, 0.12, "5h")],
		};

		const next = applyUsageReports(buildAccountInventory(storage), [teamReport, personalReport]);
		const rows = next.providers[0]?.rows ?? [];

		expect(rows.map(row => [row.orgName, row.usage.map(window => window.usedFraction)])).toEqual([
			["Example Org", [0.94]],
			["Personal", [0.12]],
		]);
	});

	/**
	 * A row with no identity at all cannot be attributed to anything, so it keeps an empty
	 * usage list rather than absorbing whatever the report happened to carry. An api-key row
	 * showing someone else's quota would be a straightforward data leak between accounts.
	 */
	test("an api-key row with no identity absorbs no limits", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		await storage.set(MULTI_ACCOUNT_PROVIDER, [{ type: "api_key", key: "raw-key" }]);
		const report: UsageReport = {
			provider: MULTI_ACCOUNT_PROVIDER,
			fetchedAt: RESETS_AT - HOUR_MS,
			metadata: { email: "someone@example.com", accountId: "account-someone" },
			limits: [limitFor("5h", { provider: MULTI_ACCOUNT_PROVIDER, accountId: "account-someone" }, 0.5, "5h")],
		};

		const next = applyUsageReports(buildAccountInventory(storage), [report]);

		expect(next.providers[0]?.rows[0]?.usage).toEqual([]);
	});

	/** A report for another provider never reaches this provider's rows. */
	test("a report for a different provider is ignored", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		await storage.set(MULTI_ACCOUNT_PROVIDER, [
			{
				type: "oauth",
				access: "access-one",
				refresh: "refresh-one",
				expires: Date.now() + HOUR_MS,
				accountId: "account-one",
				email: "one@example.com",
			},
		]);
		const foreign: UsageReport = {
			provider: "some-other-provider",
			fetchedAt: RESETS_AT - HOUR_MS,
			metadata: { accountId: "account-one" },
			limits: [limitFor("5h", { provider: "some-other-provider", accountId: "account-one" }, 0.99, "5h")],
		};

		const next = applyUsageReports(buildAccountInventory(storage), [foreign]);

		expect(next.providers[0]?.rows[0]?.usage).toEqual([]);
	});
});
