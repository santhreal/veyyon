import { describe, expect, it } from "bun:test";
import type { UsageCostHistoryEntry, UsageFetchContext, UsageFetchParams } from "../src/usage";
import { opencodeGoUsageProvider } from "../src/usage/opencode-go";

function apiKeyParams(): UsageFetchParams {
	return {
		provider: "opencode-go",
		accountKey: "acct-1",
		credential: { type: "api_key", apiKey: "sk-oc" },
	} as UsageFetchParams;
}

function ctxWithCosts(entries: UsageCostHistoryEntry[]): UsageFetchContext {
	return {
		fetch: (async () => {
			throw new Error("opencode-go usage is history-derived and must not hit the network");
		}) as unknown as UsageFetchContext["fetch"],
		listUsageCosts: () => entries,
	} as unknown as UsageFetchContext;
}

// Resolve the 5-hour window ($12 limit) after recording a single spend entry at
// `now`, so its used fraction is exactly `costUsd / 12`.
async function fiveHourLimit(costUsd: number) {
	const now = Date.now();
	const entry: UsageCostHistoryEntry = {
		recordedAt: now,
		provider: "opencode-go",
		accountKey: "acct-1",
		costUsd,
	};
	const report = await opencodeGoUsageProvider.fetchUsage(apiKeyParams(), ctxWithCosts([entry]));
	return report?.limits.find(limit => limit.window?.id === "rolling-5h");
}

describe("opencodeGoUsageProvider status uses the shared 0.9 warning owner", () => {
	it("stays ok at 0.85 used — the former stray 0.8 threshold would have warned here", async () => {
		const limit = await fiveHourLimit(10.2); // 10.2 / 12 = 0.85
		expect(limit?.amount.usedFraction).toBeCloseTo(0.85, 10);
		expect(limit?.status).toBe("ok");
	});

	it("flips to warning at exactly 0.9 used", async () => {
		const limit = await fiveHourLimit(10.8); // 10.8 / 12 = 0.9
		expect(limit?.amount.usedFraction).toBeCloseTo(0.9, 10);
		expect(limit?.status).toBe("warning");
	});

	it("is exhausted at full consumption", async () => {
		const limit = await fiveHourLimit(12); // 12 / 12 = 1.0
		expect(limit?.amount.usedFraction).toBeCloseTo(1, 10);
		expect(limit?.status).toBe("exhausted");
	});

	it("is ok with no recorded spend", async () => {
		const limit = await fiveHourLimit(0);
		expect(limit?.amount.usedFraction).toBe(0);
		expect(limit?.status).toBe("ok");
	});
});
