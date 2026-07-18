import { describe, expect, it } from "bun:test";
import type { UsageFetchContext, UsageFetchParams } from "../src/usage";
import { minimaxCodeUsageProvider } from "../src/usage/minimax-code";

// MiniMax Token Plan has no usage API yet; the provider only registers the
// account (supports gating) and always resolves to null until an endpoint exists.
const ctx = { fetch: (async () => new Response("")) as unknown as UsageFetchContext["fetch"] } as UsageFetchContext;

function params(provider: string, type: "api_key" | "oauth" = "api_key"): UsageFetchParams {
	return { provider, credential: { type, apiKey: "k" } } as UsageFetchParams;
}

describe("minimaxCodeUsageProvider", () => {
	it("supports the minimax-code / -cn api-key providers only", () => {
		const supports = minimaxCodeUsageProvider.supports?.bind(minimaxCodeUsageProvider);
		if (!supports) throw new Error("provider must declare supports");
		expect(supports(params("minimax-code"))).toBe(true);
		expect(supports(params("minimax-code-cn"))).toBe(true);
		expect(supports(params("minimax-code", "oauth"))).toBe(false);
		expect(supports(params("anthropic"))).toBe(false);
	});

	it("resolves to null (no quota endpoint yet) for supported and unrelated providers alike", async () => {
		expect(await minimaxCodeUsageProvider.fetchUsage(params("minimax-code"), ctx)).toBeNull();
		expect(await minimaxCodeUsageProvider.fetchUsage(params("minimax-code-cn"), ctx)).toBeNull();
		expect(await minimaxCodeUsageProvider.fetchUsage(params("anthropic"), ctx)).toBeNull();
	});
});
