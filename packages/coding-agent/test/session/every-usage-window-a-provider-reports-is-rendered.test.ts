/**
 * WHY THIS FILE EXISTS. An account card used to show one bar per WINDOW LABEL, so every window a
 * provider reported beyond the first of its kind vanished. Anthropic sends four windows whose
 * `window.label` is the single word `7 Day` (the umbrella weekly plus the Opus, Sonnet and
 * model-scoped weeklies), Codex sends a plan window beside a per-feature one on the same `7 days`,
 * Gemini labels every bucket `Quota window`, and Antigravity reports `Daily` once per backend
 * counter. Deduping on that label collapsed them into one row, so an operator looking at a card
 * saw a weekly bar and had no way to know three more existed, or which one the number belonged to.
 *
 * THE CLASS THIS CLOSES is "a provider reports N windows and the card shows fewer than N, or shows
 * N rows a reader cannot tell apart". It is closed at the choke point every provider passes
 * through (`applyUsageReports` -> `usageWindowLabel` -> `accountUsageLines`) and it is closed for
 * EVERY registered provider rather than the one in the bug report: the table below is checked
 * against `listRegisteredUsageProviders()` in both directions, so registering a twelfth usage
 * backend turns this file RED until someone records what its windows render as.
 *
 * Each provider case drives the provider's REAL `fetchUsage` against a canned upstream payload
 * through an injected `ctx.fetch`, so a provider that changes its own labelling is caught here
 * rather than passing against an invented `UsageReport` that no longer resembles what it sends.
 *
 * WHAT IT DOES NOT CATCH. Two windows whose labels differ only PAST the 20-cell clamp render
 * identical label columns: `google-gemini-cli` is exactly that shape today (`Quota window · Gemini
 * gemini-3-pro-preview` and `... gemini-2.5-flash` both clip to `Quota window · Gemi…`). The rows
 * stay distinguishable only by their bars, which is why the distinctness assertion is on the whole
 * rendered line and on the pre-render label, never on the clipped column. Nothing here asserts
 * colour, theme, or the sidebar's own summary line, and nothing here covers the usage FAN-OUT that
 * decides which credential gets a request in the first place.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import {
	type AuthCredential,
	AuthStorage,
	SqliteAuthCredentialStore,
	type UsageCostHistoryEntry,
	type UsageCredential,
	type UsageFetchContext,
	type UsageLimit,
	type UsageProvider,
	type UsageReport,
} from "@veyyon/ai";
import "@veyyon/ai/usage/defaults";
import { listRegisteredUsageProviders } from "@veyyon/ai/usage/registry";
import { accountUsageLines } from "@veyyon/coding-agent/modes/components/account-manager-rows";
import {
	type AccountRow,
	applyUsageReports,
	buildAccountInventory,
} from "@veyyon/coding-agent/session/account-inventory";
import { USAGE_WINDOW_LABEL_MAX } from "@veyyon/coding-agent/slash-commands/helpers/format";
import { visibleWidth } from "@veyyon/tui";
import type { FetchImpl } from "@veyyon/utils";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";

// The Kimi provider stamps a device id into the agent dir while building its request headers, so
// the file needs its own agent dir even though nothing here reads a database from it.
useIsolatedAgentDir();

const NOW_MS = 1_760_000_000_000;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

function isoAt(offsetMs: number): string {
	return new Date(NOW_MS + offsetMs).toISOString();
}

/** One registered provider, its canned upstream traffic, and what its windows must render as. */
interface ProviderCase {
	/** Credential handed to `fetchUsage`; the stored row is derived from it. */
	credential: UsageCredential;
	baseUrl?: string;
	/** Response bodies keyed by a fragment of the URL the provider builds. */
	responses?: readonly (readonly [string, unknown])[];
	costHistory?: readonly UsageCostHistoryEntry[];
	/** Every window label the card must show, in the order it must show them. */
	labels: readonly string[];
	/** Column every bar in the group starts in, which is what makes them align. */
	barColumn?: number;
}

const CODEX_ACCOUNT = "codex-account-1";
const COPILOT_USER = "octocat";

const PROVIDER_CASES: Record<string, ProviderCase> = {
	"openai-codex": {
		credential: {
			type: "oauth",
			accessToken: "codex-access",
			expiresAt: NOW_MS + HOUR_MS,
			accountId: CODEX_ACCOUNT,
			email: "codex@example.com",
		},
		responses: [
			[
				"wham/usage",
				{
					plan_type: "pro",
					rate_limit: {
						allowed: true,
						limit_reached: false,
						primary_window: { used_percent: 41, limit_window_seconds: 18_000, reset_after_seconds: 3_600 },
						secondary_window: {
							used_percent: 66,
							limit_window_seconds: 604_800,
							reset_after_seconds: 200_000,
						},
					},
					additional_rate_limits: [
						{
							limit_name: "Spark",
							metered_feature: "codex_spark",
							rate_limit: {
								primary_window: {
									used_percent: 12,
									limit_window_seconds: 604_800,
									reset_after_seconds: 500_000,
								},
							},
						},
					],
				},
			],
		],
		labels: ["5 hours", "7 days", "7 days · Spark"],
		barColumn: 15,
	},
	"kimi-code": {
		credential: { type: "oauth", accessToken: "kimi-access", expiresAt: NOW_MS + HOUR_MS },
		baseUrl: "https://kimi.test/coding/v1",
		responses: [
			[
				"/usages",
				{
					usage: { name: "Total quota", used: 1_200, limit: 5_000 },
					limits: [
						{
							name: "Prompt tokens",
							window: { duration: 5, timeUnit: "HOURS" },
							detail: { used: 300, limit: 1_000 },
						},
						{
							name: "Completion tokens",
							window: { duration: 5, timeUnit: "HOURS" },
							detail: { used: 100, limit: 1_000 },
						},
						{
							name: "Prompt tokens",
							window: { duration: 1, timeUnit: "DAYS" },
							detail: { used: 900, limit: 4_000 },
						},
					],
				},
			],
		],
		// The window-less summary row sorts last: nothing states its length, so there is nothing to
		// place it against.
		labels: ["5h limit · Prompt tokens", "5h limit · Completion tokens", "1d limit · Prompt tokens", "Total quota"],
		barColumn: 21,
	},
	"google-antigravity": {
		credential: {
			type: "oauth",
			accessToken: "antigravity-access",
			expiresAt: NOW_MS + HOUR_MS,
			projectId: "antigravity-project",
			email: "antigravity@example.com",
		},
		baseUrl: "https://antigravity.test",
		responses: [
			[
				"antigravity.test",
				{
					models: {
						"gemini-3-pro": {
							modelProvider: "MODEL_PROVIDER_GOOGLE",
							dailyQuotaInfo: { remainingFraction: 0.4, resetTime: isoAt(6 * HOUR_MS) },
							// Most exhausted, so the provider lists it FIRST; the card must still put
							// the two daily windows above it.
							weeklyQuotaInfo: { remainingFraction: 0.05, resetTime: isoAt(3 * DAY_MS) },
						},
						"claude-sonnet-4-5": {
							modelProvider: "MODEL_PROVIDER_ANTHROPIC",
							dailyQuotaInfo: { remainingFraction: 0.2, resetTime: isoAt(6 * HOUR_MS) },
						},
					},
				},
			],
		],
		labels: ["Daily · Anthropic", "Daily · Google", "Weekly · Google"],
		barColumn: 18,
	},
	"google-gemini-cli": {
		credential: {
			type: "oauth",
			accessToken: "gemini-access",
			expiresAt: NOW_MS + HOUR_MS,
			projectId: "gemini-project",
			email: "gemini@example.com",
		},
		baseUrl: "https://gemini.test",
		responses: [
			["v1internal:loadCodeAssist", { currentTier: { id: "free-tier", name: "Free" } }],
			[
				"v1internal:retrieveUserQuota",
				{
					buckets: [
						{
							modelId: "gemini-3-pro-preview",
							remainingFraction: 0.4,
							resetTime: isoAt(12 * HOUR_MS),
						},
						{ modelId: "gemini-2.5-flash", remainingFraction: 0.9, resetTime: isoAt(12 * HOUR_MS) },
					],
				},
			],
		],
		labels: ["Quota window · Gemini gemini-3-pro-preview", "Quota window · Gemini gemini-2.5-flash"],
		barColumn: 21,
	},
	ollama: {
		credential: { type: "api_key", apiKey: "ollama-key" },
		labels: [],
	},
	"ollama-cloud": {
		credential: { type: "api_key", apiKey: "ollama-cloud-key" },
		labels: [],
	},
	anthropic: {
		credential: {
			type: "oauth",
			accessToken: "claude-access",
			expiresAt: NOW_MS + HOUR_MS,
			accountId: "claude-account-1",
			email: "claude@example.com",
		},
		baseUrl: "https://claude.test/api/oauth",
		responses: [
			[
				"/usage",
				{
					account_id: "claude-account-1",
					email: "claude@example.com",
					five_hour: { utilization: 31, resets_at: isoAt(2 * HOUR_MS) },
					seven_day: { utilization: 58, resets_at: isoAt(3 * DAY_MS) },
					seven_day_opus: { utilization: 12, resets_at: isoAt(3 * DAY_MS) },
					seven_day_sonnet: { utilization: 44, resets_at: isoAt(3 * DAY_MS) },
					limits: [
						{
							kind: "weekly_scoped",
							percent: 7,
							resets_at: isoAt(3 * DAY_MS),
							scope: { model: { display_name: "Fable" } },
						},
					],
				},
			],
		],
		labels: ["5 Hour", "7 Day", "7 Day · Opus", "7 Day · Sonnet", "7 Day · Fable"],
		barColumn: 15,
	},
	zai: {
		credential: { type: "api_key", apiKey: "zai-key", accountId: "zai-account-1" },
		baseUrl: "https://zai.test",
		responses: [
			[
				"/api/monitor/usage/quota/limit",
				{
					success: true,
					data: {
						limits: [
							{
								type: "TOKENS_LIMIT",
								unit: 3,
								number: 5,
								usage: 1_000_000,
								currentValue: 250_000,
								percentage: 25,
								nextResetTime: Math.floor((NOW_MS + 2 * HOUR_MS) / 1000),
							},
							{
								type: "TIME_LIMIT",
								unit: 4,
								number: 1,
								usage: 300,
								currentValue: 42,
								percentage: 14,
								nextResetTime: Math.floor((NOW_MS + 8 * HOUR_MS) / 1000),
							},
							{
								type: "TIME_LIMIT",
								unit: 4,
								number: 1,
								usage: 50,
								currentValue: 3,
								percentage: 6,
								nextResetTime: Math.floor((NOW_MS + 8 * HOUR_MS) / 1000),
								usageDetails: [
									{ modelCode: "search-prime", usage: 1 },
									{ modelCode: "web-reader", usage: 1 },
									{ modelCode: "zread", usage: 1 },
								],
							},
						],
					},
				},
			],
			["/api/monitor/usage/model-usage", {}],
		],
		labels: ["5 Hours", "1 Day · ZAI Request Quota", "1 Day · ZAI Web Search / Reader / Zread Quota"],
		barColumn: 21,
	},
	"opencode-go": {
		credential: { type: "api_key", apiKey: "opencode-go-key" },
		costHistory: [
			{ recordedAt: NOW_MS - HOUR_MS, provider: "opencode-go", accountKey: "opencode", costUsd: 3.5 },
			{ recordedAt: NOW_MS - 3 * DAY_MS, provider: "opencode-go", accountKey: "opencode", costUsd: 7.25 },
			{ recordedAt: NOW_MS - 20 * DAY_MS, provider: "opencode-go", accountKey: "opencode", costUsd: 11 },
		],
		// Three short labels: the group sizes its own column instead of padding out to the clamp.
		labels: ["5 Hour", "Weekly", "Monthly"],
		barColumn: 8,
	},
	"github-copilot": {
		credential: { type: "api_key", apiKey: "copilot-key", accountId: COPILOT_USER },
		baseUrl: "https://github.test/api",
		responses: [
			[
				"settings/billing/premium_request/usage",
				{
					timePeriod: { year: 2026, month: 8 },
					user: COPILOT_USER,
					usageItems: [
						{
							product: "copilot",
							sku: "Copilot Premium Request",
							model: "gpt-5",
							unitType: "request",
							grossQuantity: 120,
							netQuantity: 120,
							limit: 300,
						},
						{
							product: "copilot",
							sku: "Copilot Premium Request",
							model: "claude-sonnet-4.5",
							unitType: "request",
							grossQuantity: 45,
							netQuantity: 45,
						},
					],
				},
			],
		],
		labels: ["2026-08 · Premium Requests", "2026-08 · Model gpt-5", "2026-08 · Model claude-sonnet-4.5"],
		barColumn: 21,
	},
	cursor: {
		credential: { type: "api_key", apiKey: "cursor-key", email: "cursor@example.com" },
		baseUrl: "https://cursor.test",
		responses: [
			[
				"/auth/usage",
				{
					startOfMonth: isoAt(-5 * DAY_MS),
					"gpt-4": { numRequests: 120, maxRequestUsage: 500 },
					planUsage: { usdUsed: 12.5, usdLimit: 20 },
				},
			],
		],
		labels: ["Monthly · gpt-4 requests", "Monthly · planUsage spend"],
		barColumn: 21,
	},
};

function storedCredential(credential: UsageCredential): AuthCredential {
	if (credential.type === "api_key") {
		return { type: "api_key", key: credential.apiKey ?? "unit-key" };
	}
	return {
		type: "oauth",
		access: credential.accessToken ?? "unit-access",
		refresh: "unit-refresh",
		expires: credential.expiresAt ?? NOW_MS + HOUR_MS,
		...(credential.accountId ? { accountId: credential.accountId } : {}),
		...(credential.email ? { email: credential.email } : {}),
		...(credential.projectId ? { projectId: credential.projectId } : {}),
	};
}

function fetchFromTable(responses: readonly (readonly [string, unknown])[]): FetchImpl {
	return async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const match = responses.find(([fragment]) => url.includes(fragment));
		if (!match) throw new Error(`unexpected usage request: ${url}`);
		return new Response(JSON.stringify(match[1]), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
}

function contextFor(providerCase: ProviderCase): UsageFetchContext {
	const responses = providerCase.responses ?? [];
	const history = providerCase.costHistory ?? [];
	return {
		fetch: fetchFromTable(responses),
		// Injected so a provider that retries never reaches a real clock.
		retryWait: async () => {},
		listUsageCosts: query =>
			history.filter(entry => (query?.sinceMs === undefined ? true : entry.recordedAt >= query.sinceMs)),
	};
}

async function reportFor(provider: UsageProvider, providerCase: ProviderCase): Promise<UsageReport | null> {
	return provider.fetchUsage(
		{
			provider: provider.id,
			credential: providerCase.credential,
			accountKey: `${provider.id}|unit`,
			...(providerCase.baseUrl ? { baseUrl: providerCase.baseUrl } : {}),
		},
		contextFor(providerCase),
	);
}

/** The bar opens with `[`, and no window label contains one, so this is the bar's column. */
function barColumnOf(line: string): number {
	return line.indexOf("[");
}

const registeredProviders = listRegisteredUsageProviders();

describe("every usage window a provider reports is rendered", () => {
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(() => {
		setSystemTime(new Date(NOW_MS));
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		authStorage = new AuthStorage(store);
	});

	afterEach(() => {
		store?.close();
		store = null;
		authStorage = null;
		setSystemTime();
	});

	async function rowFor(provider: string, providerCase: ProviderCase, reports: readonly UsageReport[]) {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.set(provider, [storedCredential(providerCase.credential)]);
		const inventory = applyUsageReports(buildAccountInventory(authStorage), reports);
		const row = inventory.providers.find(entry => entry.provider === provider)?.rows[0];
		if (!row) throw new Error(`no account row for ${provider}`);
		return row;
	}

	/**
	 * The table above is the decision record for every registered backend. A twelfth provider with
	 * no entry fails HERE rather than shipping a card whose windows nobody looked at, and a table
	 * entry for a backend that no longer registers fails too, so the file cannot rot in either
	 * direction.
	 */
	test("every registered usage provider has a recorded window expectation", () => {
		expect(registeredProviders.map(provider => provider.id).sort()).toEqual(Object.keys(PROVIDER_CASES).sort());
	});

	for (const provider of registeredProviders) {
		const providerCase = PROVIDER_CASES[provider.id];

		test(`${provider.id} renders each window it reports as its own labelled row`, async () => {
			if (!providerCase) throw new Error(`no recorded expectation for ${provider.id}`);
			const report = await reportFor(provider, providerCase);

			if (providerCase.labels.length === 0) {
				// Ollama and Ollama Cloud report no quota window at all. The honest render is no bars,
				// not an invented one.
				expect(report?.limits).toEqual([]);
				const emptyRow = await rowFor(provider.id, providerCase, report ? [report] : []);
				expect(emptyRow.usage).toEqual([]);
				expect(accountUsageLines(emptyRow, NOW_MS)).toEqual([]);
				return;
			}

			if (!report) throw new Error(`${provider.id} reported no usage`);
			const row = await rowFor(provider.id, providerCase, [report]);

			// One row per reported limit, in the recorded order, each label unique.
			expect(row.usage.map(window => window.label)).toEqual([...providerCase.labels]);
			expect(row.usage.length).toBe(report.limits.length);
			expect(new Set(row.usage.map(window => window.label)).size).toBe(row.usage.length);
		});

		test(`${provider.id} orders its windows shortest first and aligns their bars`, async () => {
			if (!providerCase) throw new Error(`no recorded expectation for ${provider.id}`);
			const report = await reportFor(provider, providerCase);
			if (providerCase.labels.length === 0) return;
			if (!report) throw new Error(`${provider.id} reported no usage`);
			const row = await rowFor(provider.id, providerCase, [report]);

			// Shortest window first, and every window whose length the provider never stated sits
			// after every window that stated one: there is nothing to place an unstated one against.
			const durations = row.usage.map(window => window.durationMs);
			const stated = durations.filter((value): value is number => value !== undefined);
			expect(stated).toEqual([...stated].sort((left, right) => left - right));
			const firstUnstated = durations.indexOf(undefined);
			if (firstUnstated !== -1) {
				expect(durations.slice(firstUnstated).every(value => value === undefined)).toBe(true);
			}

			const lines = accountUsageLines(row, NOW_MS);
			expect(lines.length).toBe(row.usage.length);
			// One shared column for the group, sized to the group rather than to the clamp.
			expect(new Set(lines.map(barColumnOf)).size).toBe(1);
			const expectedColumn = providerCase.barColumn;
			if (expectedColumn === undefined) throw new Error(`no recorded bar column for ${provider.id}`);
			expect(barColumnOf(lines[0] ?? "")).toBe(expectedColumn);
			expect(expectedColumn).toBeLessThanOrEqual(USAGE_WINDOW_LABEL_MAX + 1);
			// The label column never eats the bar, and no two rows render identically.
			for (const line of lines) {
				expect(visibleWidth(line.slice(0, barColumnOf(line)).trimEnd())).toBeLessThanOrEqual(
					USAGE_WINDOW_LABEL_MAX,
				);
			}
			expect(new Set(lines).size).toBe(lines.length);
		});
	}

	/**
	 * Two reports for one account reach `applyUsageReports` routinely: the header-ingested snapshot
	 * and the endpoint fetch are separate cache rows. The card shows each window once, with the
	 * freshest reading, and the winner is decided by `fetchedAt` rather than by array position.
	 */
	test("two reports for one account collapse to one row per window, keeping the freshest", async () => {
		const providerCase = PROVIDER_CASES.anthropic;
		if (!providerCase) throw new Error("test setup failed");
		const anthropic = registeredProviders.find(entry => entry.id === "anthropic");
		if (!anthropic) throw new Error("anthropic usage provider is not registered");
		const stale = await reportFor(anthropic, providerCase);
		if (!stale) throw new Error("anthropic reported no usage");
		const fresh: UsageReport = {
			...stale,
			fetchedAt: stale.fetchedAt + 60_000,
			limits: stale.limits.map(limit => ({ ...limit, amount: { ...limit.amount, usedFraction: 0.99 } })),
		};

		// Freshest LAST in one order and FIRST in the other: position must not decide.
		const freshLast = await rowFor("anthropic", providerCase, [stale, fresh]);
		expect(freshLast.usage.map(window => window.label)).toEqual([...providerCase.labels]);
		expect(freshLast.usage.map(window => window.usedFraction)).toEqual(providerCase.labels.map(() => 0.99));

		store?.close();
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		authStorage = new AuthStorage(store);
		const freshFirst = await rowFor("anthropic", providerCase, [fresh, stale]);
		expect(freshFirst.usage.map(window => window.label)).toEqual([...providerCase.labels]);
		expect(freshFirst.usage.map(window => window.usedFraction)).toEqual(providerCase.labels.map(() => 0.99));
	});
});

/**
 * A provider holding exactly ONE credential takes its report unconditionally, and a provider with
 * siblings does not. Matching exists to arbitrate between accounts; with no sibling there is
 * nothing to arbitrate, and requiring a match there is how Cursor and Kimi rows (whose stored
 * credential carries no email or account id at all) showed no usage whatsoever.
 *
 * Parameterized over every registered provider on purpose: the previous shape of this rule was
 * applied to the provider someone had in mind, and the recurring defect in this area is a fix that
 * covers one member of a union.
 */
describe("identity matching arbitrates between siblings and only between siblings", () => {
	const FOREIGN_ACCOUNT = "somebody-elses-account";
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(() => {
		setSystemTime(new Date(NOW_MS));
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		authStorage = new AuthStorage(store);
	});

	afterEach(() => {
		store?.close();
		store = null;
		authStorage = null;
		setSystemTime();
	});

	function foreignLimit(provider: string): UsageLimit {
		return {
			id: `${provider}:foreign`,
			label: "Weekly limit",
			scope: { provider, accountId: FOREIGN_ACCOUNT, windowId: "weekly" },
			window: { id: "weekly", label: "Weekly", durationMs: 7 * DAY_MS, resetsAt: NOW_MS + DAY_MS },
			amount: { used: 40, limit: 100, usedFraction: 0.4, unit: "percent" },
			status: "ok",
		};
	}

	for (const provider of registeredProviders) {
		test(`${provider.id}: a sole identity-less credential absorbs its provider's report`, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await authStorage.set(provider.id, [{ type: "api_key", key: `${provider.id}-only` }]);
			const report: UsageReport = {
				provider: provider.id,
				fetchedAt: NOW_MS,
				limits: [foreignLimit(provider.id)],
			};

			const inventory = applyUsageReports(buildAccountInventory(authStorage), [report]);
			const rows = inventory.providers.find(entry => entry.provider === provider.id)?.rows ?? [];
			expect(rows.map((row: AccountRow) => row.usage.map(window => window.label))).toEqual([["Weekly"]]);
		});

		test(`${provider.id}: an identity-less credential absorbs nothing once a sibling exists`, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await authStorage.set(provider.id, [
				{ type: "api_key", key: `${provider.id}-anonymous` },
				{
					type: "oauth",
					access: "sibling-access",
					refresh: "sibling-refresh",
					expires: NOW_MS + HOUR_MS,
					accountId: FOREIGN_ACCOUNT,
					email: "sibling@example.com",
				},
			]);
			const report: UsageReport = {
				provider: provider.id,
				fetchedAt: NOW_MS,
				limits: [foreignLimit(provider.id)],
			};

			const inventory = applyUsageReports(buildAccountInventory(authStorage), [report]);
			const rows = inventory.providers.find(entry => entry.provider === provider.id)?.rows ?? [];
			expect(rows.length).toBe(2);
			const anonymous = rows.find((row: AccountRow) => row.type === "api_key");
			const sibling = rows.find((row: AccountRow) => row.accountId === FOREIGN_ACCOUNT);
			expect(anonymous?.usage).toEqual([]);
			expect(sibling?.usage.map(window => window.label)).toEqual(["Weekly"]);
		});
	}
});
