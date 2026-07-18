import { describe, expect, it } from "bun:test";
import type { UsageFetchContext, UsageFetchParams } from "../src/usage";
import { ollamaCloudUsageProvider, ollamaUsageProvider } from "../src/usage/ollama";

// Ollama exposes no quota API; the provider still registers so the account
// surfaces in usage views, returning an empty-limit report with an explanatory
// note and whatever identity metadata the credential carries.
const ctx = { fetch: (async () => new Response("")) as unknown as UsageFetchContext["fetch"] } as UsageFetchContext;

function params(provider: string, credential: Partial<UsageFetchParams["credential"]> = {}): UsageFetchParams {
	return { provider, credential: { type: "api_key", ...credential } } as UsageFetchParams;
}

describe("ollama usage providers", () => {
	it("each supports only its own provider id", () => {
		expect(ollamaUsageProvider.supports?.(params("ollama"))).toBe(true);
		expect(ollamaUsageProvider.supports?.(params("ollama-cloud"))).toBe(false);
		expect(ollamaCloudUsageProvider.supports?.(params("ollama-cloud"))).toBe(true);
		expect(ollamaCloudUsageProvider.supports?.(params("ollama"))).toBe(false);
	});

	it("declare that they do not validate credentials", () => {
		expect(ollamaUsageProvider.validatesCredentials).toBe(false);
		expect(ollamaCloudUsageProvider.validatesCredentials).toBe(false);
	});

	it("returns an empty-limit report with the no-quota-API note and identity metadata", async () => {
		const report = await ollamaCloudUsageProvider.fetchUsage(
			params("ollama-cloud", { email: "a@b.co", accountId: "acct", projectId: "proj" }),
			ctx,
		);
		expect(report).not.toBeNull();
		expect(report?.provider).toBe("ollama-cloud");
		expect(report?.limits).toEqual([]);
		expect(report?.notes?.[0]).toContain("does not expose a standalone quota usage API");
		expect(report?.metadata).toEqual({ email: "a@b.co", accountId: "acct", projectId: "proj" });
	});

	it("omits metadata entirely when the credential carries no identity fields", async () => {
		const report = await ollamaUsageProvider.fetchUsage(params("ollama"), ctx);
		expect(report?.metadata).toBeUndefined();
	});

	it("returns null for an unrelated provider", async () => {
		expect(await ollamaUsageProvider.fetchUsage(params("anthropic"), ctx)).toBeNull();
	});
});
