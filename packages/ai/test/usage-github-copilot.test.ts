import { describe, expect, it } from "bun:test";
import type { UsageFetchContext, UsageFetchParams } from "../src/usage";
import { githubCopilotUsageProvider } from "../src/usage/github-copilot";

type Route = { match: (url: string) => boolean; status?: number; body: unknown };

function ctxWith(routes: Route[]): { ctx: UsageFetchContext; urls: string[] } {
	const urls: string[] = [];
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
	} satisfies UsageFetchContext;
	return { ctx, urls };
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
});
