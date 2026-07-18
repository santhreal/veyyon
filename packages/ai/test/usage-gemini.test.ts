import { describe, expect, it } from "bun:test";
import type { UsageFetchContext, UsageFetchParams } from "../src/usage";
import { googleGeminiCliUsageProvider } from "../src/usage/gemini";

type Routes = { load?: unknown; quota?: unknown; loadStatus?: number; quotaStatus?: number };

function ctxRouting(routes: Routes): { ctx: UsageFetchContext; urls: string[] } {
	const urls: string[] = [];
	const ctx = {
		fetch: (async (url: string | URL | Request) => {
			const u = String(url);
			urls.push(u);
			if (u.includes("loadCodeAssist")) {
				return new Response(routes.loadStatus === undefined ? JSON.stringify(routes.load ?? {}) : "", {
					status: routes.loadStatus ?? 200,
				});
			}
			return new Response(routes.quotaStatus === undefined ? JSON.stringify(routes.quota ?? {}) : "", {
				status: routes.quotaStatus ?? 200,
			});
		}) as unknown as UsageFetchContext["fetch"],
	} satisfies UsageFetchContext;
	return { ctx, urls };
}

function params(overrides: Partial<UsageFetchParams["credential"]> = {}): UsageFetchParams {
	return {
		provider: "google-gemini-cli",
		credential: { type: "oauth", accessToken: "tok", accountId: "acct", ...overrides },
	} as UsageFetchParams;
}

describe("googleGeminiCliUsageProvider.supports", () => {
	it("requires an oauth credential carrying an access token", () => {
		const supports = googleGeminiCliUsageProvider.supports?.bind(googleGeminiCliUsageProvider);
		if (!supports) throw new Error("provider must declare supports");
		expect(supports(params())).toBe(true);
		expect(supports(params({ accessToken: undefined }))).toBe(false);
		expect(
			supports({ provider: "google-gemini-cli", credential: { type: "api_key", apiKey: "k" } } as UsageFetchParams),
		).toBe(false);
	});
});

describe("googleGeminiCliUsageProvider.fetchUsage", () => {
	it("maps quota buckets to per-model limits with tier, window, and percent amounts", async () => {
		const { ctx, urls } = ctxRouting({
			load: { cloudaicompanionProject: { id: "proj-9" }, currentTier: { id: "tier-pro", name: "Pro" } },
			quota: {
				buckets: [
					{ modelId: "gemini-2.5-pro", remainingFraction: 0.25, resetTime: "2030-01-01T00:00:00Z" },
					{ modelId: "gemini-2.5-flash", remainingFraction: 1 },
					{ modelId: "custom-flash-turbo", remainingFraction: 0.5 },
					{},
				],
			},
		});

		const report = await googleGeminiCliUsageProvider.fetchUsage(params(), ctx);
		expect(report).not.toBeNull();
		if (!report) return;

		expect(urls[0]).toContain("/v1internal:loadCodeAssist");
		expect(urls[1]).toContain("/v1internal:retrieveUserQuota");
		expect(report.metadata).toEqual({ currentTierId: "tier-pro", currentTierName: "Pro" });
		expect(report.limits).toHaveLength(4);

		const [pro, flash, fallbackFlash, unknown] = report.limits;

		// Exact tier-map hit + resettable window.
		expect(pro.label).toBe("Gemini gemini-2.5-pro");
		expect(pro.scope.tier).toBe("Pro");
		expect(pro.scope.projectId).toBe("proj-9");
		expect(pro.window?.resetsAt).toBe(Date.parse("2030-01-01T00:00:00Z"));
		expect(pro.window?.id).toBe(`reset-${Date.parse("2030-01-01T00:00:00Z")}`);
		expect(pro.amount).toMatchObject({
			unit: "percent",
			used: 75,
			remaining: 25,
			limit: 100,
			usedFraction: 0.75,
			remainingFraction: 0.25,
		});

		// Full remaining, no reset -> generic quota window.
		expect(flash.scope.tier).toBe("Flash");
		expect(flash.window?.id).toBe("quota");
		expect(flash.amount).toMatchObject({ used: 0, remaining: 100, usedFraction: 0, remainingFraction: 1 });

		// Unmapped id -> normalized-substring tier fallback.
		expect(fallbackFlash.scope.tier).toBe("Flash");
		expect(fallbackFlash.amount.usedFraction).toBe(0.5);

		// No modelId, no remainingFraction -> generic label + unit-only amount.
		expect(unknown.label).toBe("Gemini quota");
		expect(unknown.id).toBe("unknown:quota");
		expect(unknown.amount).toEqual({ unit: "percent" });
	});

	it("prefers the credential projectId over the loadCodeAssist project", async () => {
		const { ctx } = ctxRouting({
			load: { cloudaicompanionProject: "server-proj" },
			quota: { buckets: [{ modelId: "gemini-2.5-pro", remainingFraction: 0.1 }] },
		});
		const report = await googleGeminiCliUsageProvider.fetchUsage(params({ projectId: "cred-proj" }), ctx);
		expect(report?.limits[0].scope.projectId).toBe("cred-proj");
	});

	it("returns null when quota retrieval fails", async () => {
		const { ctx } = ctxRouting({ load: {}, quotaStatus: 500 });
		expect(await googleGeminiCliUsageProvider.fetchUsage(params(), ctx)).toBeNull();
	});

	it("returns null and never calls the network when the token is expired", async () => {
		const { ctx, urls } = ctxRouting({ quota: { buckets: [] } });
		expect(await googleGeminiCliUsageProvider.fetchUsage(params({ expiresAt: Date.now() - 1 }), ctx)).toBeNull();
		expect(urls).toEqual([]);
	});
});
