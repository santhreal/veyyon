import { describe, expect, it } from "bun:test";
import type { UsageFetchContext, UsageFetchParams } from "../src/usage";
import { kimiUsageProvider } from "../src/usage/kimi";

function ctxReturning(payload: unknown, status = 200): { ctx: UsageFetchContext; calls: string[] } {
	const calls: string[] = [];
	const ctx = {
		fetch: (async (url: string | URL | Request) => {
			calls.push(String(url));
			return new Response(status === 200 ? JSON.stringify(payload) : "", { status });
		}) as unknown as UsageFetchContext["fetch"],
	} satisfies UsageFetchContext;
	return { ctx, calls };
}

function oauthParams(overrides: Partial<UsageFetchParams["credential"]> = {}): UsageFetchParams {
	return {
		provider: "kimi-code",
		baseUrl: "https://api.kimi.com/coding/v1",
		credential: { type: "oauth", accessToken: "kimi-token", accountId: "acct-1", ...overrides },
	} as UsageFetchParams;
}

describe("kimiUsageProvider.supports", () => {
	it("claims kimi-code oauth credentials only", () => {
		const supports = kimiUsageProvider.supports?.bind(kimiUsageProvider);
		if (!supports) throw new Error("kimiUsageProvider must declare a supports predicate");
		expect(supports(oauthParams())).toBe(true);
		expect(
			supports({
				provider: "kimi-code",
				credential: { type: "api_key", apiKey: "k" },
			} as UsageFetchParams),
		).toBe(false);
		expect(
			supports({
				provider: "anthropic",
				credential: { type: "oauth", accessToken: "t" },
			} as UsageFetchParams),
		).toBe(false);
	});
});

describe("kimiUsageProvider.fetchUsage", () => {
	it("parses the summary + windowed limits into normalized usage limits", async () => {
		const { ctx, calls } = ctxReturning({
			usage: { name: "Total", used: 90, limit: 100 },
			limits: [
				{ name: "5h", detail: { used: 45, limit: 100 }, window: { duration: 5, timeUnit: "HOURS" } },
				{ detail: { used: 100, limit: 100 }, window: { duration: 120, timeUnit: "MINUTES" } },
			],
		});

		const report = await kimiUsageProvider.fetchUsage(oauthParams(), ctx);
		expect(report).not.toBeNull();
		if (!report) return;

		expect(report.provider).toBe("kimi-code");
		expect(typeof report.fetchedAt).toBe("number");
		expect(report.metadata?.endpoint).toBe("https://api.kimi.com/coding/v1/usages");
		expect(calls).toEqual(["https://api.kimi.com/coding/v1/usages"]);

		expect(report.limits).toHaveLength(3);

		const [total, hours, minutes] = report.limits;
		// Summary row: 90/100 used -> 0.9 fraction -> warning.
		expect(total.label).toBe("Total");
		expect(total.id).toBe("kimi-code:0");
		expect(total.amount.used).toBe(90);
		expect(total.amount.limit).toBe(100);
		expect(total.amount.usedFraction).toBeCloseTo(0.9, 10);
		expect(total.status).toBe("warning");

		// Named 5h window: 45/100 -> 0.45 -> ok; window derived from HOURS.
		expect(hours.label).toBe("5h");
		expect(hours.amount.usedFraction).toBeCloseTo(0.45, 10);
		expect(hours.status).toBe("ok");
		expect(hours.window?.durationMs).toBe(5 * 3_600_000);
		expect(hours.window?.label).toBe("5h limit");
		expect(hours.window?.id).toBe("5hours");

		// Unnamed minute window: label falls back to the formatted duration;
		// 100/100 -> exhausted; 120 MINUTES rolls up to a 2h label but stays in
		// minute-derived durationMs.
		expect(minutes.label).toBe("2h limit");
		expect(minutes.status).toBe("exhausted");
		expect(minutes.window?.durationMs).toBe(120 * 60_000);
		expect(minutes.window?.id).toBe("120minutes");
	});

	it("derives used from limit minus remaining when only remaining is reported", async () => {
		const { ctx } = ctxReturning({ usage: { name: "Q", limit: 200, remaining: 50 } });
		const report = await kimiUsageProvider.fetchUsage(oauthParams(), ctx);
		expect(report?.limits[0].amount.used).toBe(150);
		expect(report?.limits[0].amount.remaining).toBe(50);
		expect(report?.limits[0].amount.usedFraction).toBeCloseTo(0.75, 10);
	});

	it("returns null when the token is already expired", async () => {
		const { ctx, calls } = ctxReturning({ usage: { used: 1, limit: 2 } });
		const report = await kimiUsageProvider.fetchUsage(oauthParams({ expiresAt: Date.now() - 1 }), ctx);
		expect(report).toBeNull();
		// Short-circuits before hitting the network.
		expect(calls).toEqual([]);
	});

	it("returns null on a non-ok response", async () => {
		const { ctx } = ctxReturning({}, 429);
		expect(await kimiUsageProvider.fetchUsage(oauthParams(), ctx)).toBeNull();
	});

	it("returns null when the payload yields no usable rows", async () => {
		const { ctx } = ctxReturning({ usage: {}, limits: [] });
		expect(await kimiUsageProvider.fetchUsage(oauthParams(), ctx)).toBeNull();
	});
});
