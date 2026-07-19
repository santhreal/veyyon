import { describe, expect, it } from "bun:test";
import type { UsageFetchContext, UsageFetchParams } from "../src/usage";
import { githubCopilotUsageProvider } from "../src/usage/github-copilot";

type Route = { match: (url: string) => boolean; status?: number; body: unknown };

function ctxWith(routes: Route[]): { ctx: UsageFetchContext; urls: string[]; warns: string[] } {
	const urls: string[] = [];
	const warns: string[] = [];
	const ctx = {
		fetch: (async (url: string | URL | Request) => {
			const u = String(url);
			urls.push(u);
			const route = routes.find(r => r.match(u));
			if (!route) return new Response("not routed", { status: 404 });
			return new Response(route.status && route.status !== 200 ? "err" : JSON.stringify(route.body), {
				status: route.status ?? 200,
			});
		}) as unknown as UsageFetchContext["fetch"],
		logger: { warn: (message: string) => warns.push(message) } as unknown as UsageFetchContext["logger"],
	} satisfies UsageFetchContext;
	return { ctx, urls, warns };
}

const INTERNAL = (u: string) => u.includes("/copilot_internal/user");
const BILLING = (u: string) => u.includes("/premium_request/usage");
const USER = (u: string) => u.endsWith("/user");

function oauth(overrides: Partial<UsageFetchParams["credential"]> = {}): UsageFetchParams {
	return {
		provider: "github-copilot",
		credential: { type: "oauth", accessToken: "gho_tok", accountId: "octo", ...overrides },
	} as UsageFetchParams;
}
function apiKey(overrides: Partial<UsageFetchParams["credential"]> = {}): UsageFetchParams {
	return {
		provider: "github-copilot",
		credential: { type: "api_key", apiKey: "ghp_tok", accountId: "octo", ...overrides },
	} as UsageFetchParams;
}

const internalUsageBody = {
	copilot_plan: "Pro",
	quota_reset_date: "2030-06-01T00:00:00Z",
	quota_snapshots: {
		premium_interactions: {
			entitlement: 300,
			remaining: 60,
			percent_remaining: 20,
			unlimited: false,
			overage_count: 5,
			overage_permitted: true,
			quota_id: "prem",
			quota_remaining: 60,
		},
		chat: { entitlement: 0, remaining: 0, percent_remaining: 100, unlimited: true },
		completions: { entitlement: 100, remaining: 0, percent_remaining: 0, unlimited: false },
	},
};

describe("githubCopilotUsageProvider.supports", () => {
	const supports = githubCopilotUsageProvider.supports?.bind(githubCopilotUsageProvider);
	it("gates on provider + a usable credential", () => {
		if (!supports) throw new Error("provider must declare supports");
		expect(supports(oauth())).toBe(true);
		expect(supports(oauth({ accessToken: undefined, refreshToken: "ghr" }))).toBe(true);
		expect(supports(oauth({ accessToken: undefined, refreshToken: undefined }))).toBe(false);
		expect(supports(apiKey())).toBe(true);
		expect(supports(apiKey({ apiKey: undefined }))).toBe(false);
		expect(
			supports({ provider: "anthropic", credential: { type: "api_key", apiKey: "x" } } as UsageFetchParams),
		).toBe(false);
	});
});

describe("githubCopilotUsageProvider oauth path (internal quota snapshots)", () => {
	it("normalizes premium + completions snapshots and skips the unlimited chat quota", async () => {
		const { ctx, urls } = ctxWith([{ match: INTERNAL, body: internalUsageBody }]);
		const report = await githubCopilotUsageProvider.fetchUsage(oauth(), ctx);
		expect(report).not.toBeNull();
		if (!report) return;

		expect(urls[0]).toBe("https://api.github.com/copilot_internal/user");
		expect(report.metadata).toMatchObject({ accountId: "octo", plan: "Pro", quotaResetDate: "2030-06-01T00:00:00Z" });
		expect(report.raw).toEqual(internalUsageBody);

		// Unlimited chat is dropped; premium + completions remain in order.
		expect(report.limits.map(l => l.id)).toEqual(["copilot:premium", "copilot:completions"]);

		const premium = report.limits[0];
		expect(premium.amount).toMatchObject({ used: 240, limit: 300, remaining: 60, usedFraction: 0.8 });
		expect(premium.amount.remainingFraction).toBeCloseTo(0.2, 10);
		expect(premium.status).toBe("ok");
		expect(premium.notes).toEqual(["Overage requests: 5"]);
		expect(premium.window).toMatchObject({ id: "monthly", resetsAt: Date.parse("2030-06-01T00:00:00Z") });

		// Completions fully drained -> exhausted.
		expect(report.limits[1].amount).toMatchObject({ used: 100, limit: 100 });
		expect(report.limits[1].status).toBe("exhausted");
	});

	it("resolves the enterprise API base url from a bare host", async () => {
		const { ctx, urls } = ctxWith([{ match: INTERNAL, body: internalUsageBody }]);
		await githubCopilotUsageProvider.fetchUsage(oauth({ enterpriseUrl: "ghe.corp.example" }), ctx);
		expect(urls[0]).toBe("https://api.ghe.corp.example/copilot_internal/user");
	});
});

describe("githubCopilotUsageProvider api_key path (billing usage)", () => {
	const billingBody = {
		timePeriod: { year: 2030, month: 6 },
		user: "octo",
		usageItems: [
			{ product: "copilot", sku: "Copilot Premium Request", unitType: "request", grossQuantity: 120, limit: 300 },
			{
				product: "copilot",
				sku: "Copilot Premium Request",
				model: "gpt-4o",
				unitType: "request",
				grossQuantity: 40,
				limit: 100,
			},
			{ product: "x", sku: "Other", unitType: "request", grossQuantity: 5 },
		],
	};

	it("aggregates premium billing items and emits a per-model limit", async () => {
		const { ctx } = ctxWith([{ match: BILLING, body: billingBody }]);
		const report = await githubCopilotUsageProvider.fetchUsage(apiKey(), ctx);
		expect(report).not.toBeNull();
		if (!report) return;

		expect(report.metadata).toMatchObject({ accountId: "octo", account: "octo", period: { year: 2030, month: 6 } });
		expect(report.limits.map(l => l.id)).toEqual(["copilot:premium", "copilot:model:gpt-4o"]);
		// Sum of the two premium-sku items' gross vs. their summed limits.
		expect(report.limits[0].amount).toMatchObject({ used: 160, limit: 400, remaining: 240 });
		expect(report.limits[0].window).toMatchObject({ id: "billing-period", label: "2030-06" });
		expect(report.limits[1].amount).toMatchObject({ used: 40, limit: 100 });
	});

	it("resolves the username via /user when the credential omits an account id", async () => {
		const { ctx, urls } = ctxWith([
			{ match: USER, body: { login: "resolved-user" } },
			{ match: BILLING, body: { ...billingBody, user: "resolved-user" } },
		]);
		const report = await githubCopilotUsageProvider.fetchUsage(apiKey({ accountId: undefined }), ctx);
		expect(urls.some(u => u.endsWith("/user"))).toBe(true);
		expect(urls.some(u => u.includes("/users/resolved-user/"))).toBe(true);
		expect(report?.metadata?.accountId).toBe("resolved-user");
	});

	it("falls back to internal quota when the billing API errors", async () => {
		const { ctx } = ctxWith([
			{ match: BILLING, status: 500, body: {} },
			{ match: INTERNAL, body: internalUsageBody },
		]);
		const report = await githubCopilotUsageProvider.fetchUsage(apiKey(), ctx);
		// Billing threw -> internal quota report used instead.
		expect(report?.metadata).toMatchObject({ plan: "Pro" });
		expect(report?.limits.map(l => l.id)).toEqual(["copilot:premium", "copilot:completions"]);
	});

	it("resolves the username from credential metadata without calling /user", async () => {
		const { ctx, urls } = ctxWith([
			{ match: BILLING, body: { timePeriod: { year: 2030, month: 6 }, user: "meta-user", usageItems: [] } },
		]);
		const params = apiKey({ accountId: undefined, metadata: { username: "meta-user" } });
		const report = await githubCopilotUsageProvider.fetchUsage(params, ctx);
		expect(urls.some(u => u.endsWith("/user"))).toBe(false);
		expect(urls.some(u => u.includes("/users/meta-user/"))).toBe(true);
		expect(report?.metadata?.accountId).toBe("meta-user");
	});

	it("returns null and warns when no username can be resolved and internal usage is unreachable", async () => {
		// /user resolves to an object with no login (INTERNAL is checked first so the
		// internal endpoint, which also ends in `/user`, fails rather than reusing this body).
		const { ctx, warns } = ctxWith([
			{ match: INTERNAL, status: 500, body: {} },
			{ match: USER, body: { name: "no-login-field" } },
		]);
		const report = await githubCopilotUsageProvider.fetchUsage(apiKey({ accountId: undefined }), ctx);
		expect(report).toBeNull();
		expect(warns).toContain("Copilot usage requires username for billing API");
		expect(warns).toContain("Copilot usage fetch failed");
	});

	it("returns null and warns twice when both billing and internal usage error", async () => {
		const { ctx, warns } = ctxWith([
			{ match: BILLING, status: 500, body: {} },
			{ match: INTERNAL, status: 500, body: {} },
		]);
		const report = await githubCopilotUsageProvider.fetchUsage(apiKey(), ctx);
		expect(report).toBeNull();
		expect(warns.filter(w => w === "Copilot usage fetch failed")).toHaveLength(2);
	});

	it("labels the billing window by year alone when the period has no month and skips zero-usage models", async () => {
		const { ctx } = ctxWith([
			{
				match: BILLING,
				body: {
					timePeriod: { year: 2031 },
					user: "octo",
					usageItems: [
						{ product: "copilot", sku: "Copilot Premium Request", unitType: "request", grossQuantity: 50 },
						{
							product: "copilot",
							sku: "Copilot Premium Request",
							model: "idle-model",
							unitType: "request",
							grossQuantity: 0,
						},
					],
				},
			},
		]);
		const report = await githubCopilotUsageProvider.fetchUsage(apiKey(), ctx);
		// Year-only label, and the zero-gross per-model item is dropped.
		expect(report?.limits.map(l => l.id)).toEqual(["copilot:premium"]);
		expect(report?.limits[0].window).toMatchObject({ id: "billing-period", label: "2031" });
		// No `limit` field on the items -> unknown status (no fraction computable).
		expect(report?.limits[0].amount).toMatchObject({ used: 50, limit: undefined, remaining: undefined });
		expect(report?.limits[0].status).toBe("unknown");
	});
});

describe("githubCopilotUsageProvider oauth refresh-token path", () => {
	it("uses the refresh token as the Copilot token and resolves the account id via /user", async () => {
		const { ctx, urls } = ctxWith([
			{ match: INTERNAL, body: internalUsageBody },
			{ match: USER, body: { login: "refresh-user" } },
		]);
		const params = oauth({ accessToken: undefined, refreshToken: "ghr_x", accountId: undefined });
		const report = await githubCopilotUsageProvider.fetchUsage(params, ctx);
		expect(urls.some(u => u.endsWith("/user"))).toBe(true);
		expect(report?.metadata?.accountId).toBe("refresh-user");
		expect(report?.limits[0].scope.accountId).toBe("refresh-user");
	});

	it("returns null when the internal usage response is not an object", async () => {
		const { ctx, warns } = ctxWith([{ match: INTERNAL, body: [] }]);
		const report = await githubCopilotUsageProvider.fetchUsage(oauth(), ctx);
		expect(report).toBeNull();
		expect(warns).toContain("Copilot usage fetch failed");
	});
});

describe("resolveGitHubApiBaseUrl (observed through the internal usage URL)", () => {
	async function baseUrlFor(params: UsageFetchParams): Promise<string> {
		const { ctx, urls } = ctxWith([{ match: INTERNAL, body: internalUsageBody }]);
		await githubCopilotUsageProvider.fetchUsage(params, ctx);
		return urls[0].replace("/copilot_internal/user", "");
	}

	it("uses an explicit non-Copilot base url verbatim (trailing slash trimmed)", async () => {
		expect(await baseUrlFor({ ...oauth(), baseUrl: "https://ghe.example/api/v3/" } as UsageFetchParams)).toBe(
			"https://ghe.example/api/v3",
		);
	});

	it("ignores a githubcopilot.com base url and falls back to api.github.com", async () => {
		expect(await baseUrlFor({ ...oauth(), baseUrl: "https://api.githubcopilot.com" } as UsageFetchParams)).toBe(
			"https://api.github.com",
		);
	});

	it("uses an enterprise url with an explicit scheme verbatim (trimmed)", async () => {
		expect(await baseUrlFor(oauth({ enterpriseUrl: "https://ghe.corp/" }))).toBe("https://ghe.corp");
	});

	it("prefixes a bare api.* enterprise host with https:// only", async () => {
		expect(await baseUrlFor(oauth({ enterpriseUrl: "api.ghe.corp" }))).toBe("https://api.ghe.corp");
	});
});

describe("quota snapshot edge cases", () => {
	it("drops a premium snapshot that is missing a required field and keeps a valid chat quota", async () => {
		const body = {
			copilot_plan: "Business",
			quota_reset_date: "2030-06-01T00:00:00Z",
			quota_snapshots: {
				// `remaining` absent -> parseQuotaDetail returns null -> premium dropped.
				premium_interactions: { entitlement: 300, percent_remaining: 20, unlimited: false },
				chat: { entitlement: 200, remaining: 50, percent_remaining: 25, unlimited: false },
			},
		};
		const { ctx } = ctxWith([{ match: INTERNAL, body }]);
		const report = await githubCopilotUsageProvider.fetchUsage(oauth(), ctx);
		expect(report?.limits.map(l => l.id)).toEqual(["copilot:chat"]);
	});

	it("emits a warning status when a quota is nearly exhausted (<=10% remaining)", async () => {
		const body = {
			copilot_plan: "Pro",
			quota_reset_date: "2030-06-01T00:00:00Z",
			quota_snapshots: {
				premium_interactions: {
					entitlement: 300,
					remaining: 15,
					percent_remaining: 5,
					unlimited: false,
					overage_count: 0,
					quota_id: "prem",
					quota_remaining: 15,
				},
			},
		};
		const { ctx } = ctxWith([{ match: INTERNAL, body }]);
		const report = await githubCopilotUsageProvider.fetchUsage(oauth(), ctx);
		expect(report?.limits[0].amount).toMatchObject({ used: 285, remaining: 15 });
		expect(report?.limits[0].amount.remainingFraction).toBeCloseTo(0.05, 10);
		expect(report?.limits[0].status).toBe("warning");
	});

	it("omits the window when the quota reset date is absent or unparseable", async () => {
		const noDate = {
			copilot_plan: "Pro",
			quota_snapshots: {
				premium_interactions: {
					entitlement: 300,
					remaining: 60,
					percent_remaining: 20,
					unlimited: false,
					quota_id: "prem",
					quota_remaining: 60,
				},
			},
		};
		const { ctx } = ctxWith([{ match: INTERNAL, body: noDate }]);
		const report = await githubCopilotUsageProvider.fetchUsage(oauth(), ctx);
		expect(report?.limits[0].window).toBeUndefined();

		const badDate = { ...noDate, quota_reset_date: "not-a-real-date" };
		const second = ctxWith([{ match: INTERNAL, body: badDate }]);
		const report2 = await githubCopilotUsageProvider.fetchUsage(oauth(), second.ctx);
		expect(report2?.limits[0].window).toBeUndefined();
	});
});
