import { describe, expect, it } from "bun:test";
import type { UsageFetchParams } from "../src/usage";
import { minimaxCodeUsageProvider } from "../src/usage/minimax-code";

function makeParams(provider: string, credType: string = "api_key"): UsageFetchParams {
	return {
		provider,
		credential: { type: credType } as UsageFetchParams["credential"],
	} as UsageFetchParams;
}

describe("minimaxCodeUsageProvider", () => {
	it("has id 'minimax-code'", () => {
		expect(minimaxCodeUsageProvider.id).toBe("minimax-code");
	});
	it("supports minimax-code with api_key", () => {
	expect(minimaxCodeUsageProvider.supports?.(makeParams("minimax-code"))).toBe(true);
	});
	it("supports minimax-code-cn with api_key", () => {
	expect(minimaxCodeUsageProvider.supports?.(makeParams("minimax-code-cn"))).toBe(true);
	});
	it("does not support other providers", () => {
	expect(minimaxCodeUsageProvider.supports?.(makeParams("anthropic"))).toBe(false);
	});
	it("does not support non-api_key credentials", () => {
	expect(minimaxCodeUsageProvider.supports?.(makeParams("minimax-code", "oauth"))).toBe(false);
	});
	it("fetchUsage returns null for minimax-code", async () => {
		const result = await minimaxCodeUsageProvider.fetchUsage(
			makeParams("minimax-code"),
			{} as Parameters<typeof minimaxCodeUsageProvider.fetchUsage>[1],
		);
		expect(result).toBeNull();
	});
	it("fetchUsage returns null for minimax-code-cn", async () => {
		const result = await minimaxCodeUsageProvider.fetchUsage(
			makeParams("minimax-code-cn"),
			{} as Parameters<typeof minimaxCodeUsageProvider.fetchUsage>[1],
		);
		expect(result).toBeNull();
	});
	it("fetchUsage returns null for unknown provider", async () => {
		const result = await minimaxCodeUsageProvider.fetchUsage(
			makeParams("unknown"),
			{} as Parameters<typeof minimaxCodeUsageProvider.fetchUsage>[1],
		);
		expect(result).toBeNull();
	});
});
