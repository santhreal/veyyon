import { afterEach, describe, expect, it } from "bun:test";
import {
	cursorModelManagerOptions,
	devinModelManagerOptions,
	gitLabDuoWorkflowModelManagerOptions,
	openaiCodexModelManagerOptions,
	zaiModelManagerOptions,
} from "../src/provider-models/special";

// These builders gate the dynamic-discovery closure on a present credential:
// no credential -> a bare static provider config; credential -> a wired
// `fetchDynamicModels` that carries the secret into the exact discovery call.
// Lock both the gating shape and the credential wiring end to end.

describe("openaiCodexModelManagerOptions", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it("returns a bare provider config with no dynamic fetcher when unauthenticated", () => {
		const options = openaiCodexModelManagerOptions();
		expect(options.providerId).toBe("openai-codex");
		expect(options.fetchDynamicModels).toBeUndefined();
	});

	it("wires an access-token-backed fetcher that returns the discovered models", async () => {
		const options = openaiCodexModelManagerOptions({ accessToken: "codex-secret", clientVersion: "1.2.3" });
		expect(options.providerId).toBe("openai-codex");
		expect(typeof options.fetchDynamicModels).toBe("function");

		let sawAuth = "";
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			sawAuth = headers.get("Authorization") ?? "";
			return new Response(JSON.stringify({ data: [{ slug: "gpt-5-codex" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;

		const models = await options.fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(["gpt-5-codex"]);
		expect(sawAuth).toContain("codex-secret");
	});
});

describe("cursorModelManagerOptions", () => {
	it("namespaces the cache under the max-mode-v2 id even without a credential", () => {
		const options = cursorModelManagerOptions();
		expect(options.providerId).toBe("cursor");
		expect(options.cacheProviderId).toBe("cursor:max-mode-v2");
		expect(options.fetchDynamicModels).toBeUndefined();
	});

	it("attaches a dynamic fetcher once an api key is supplied", () => {
		const options = cursorModelManagerOptions({ apiKey: "cursor-key" });
		expect(typeof options.fetchDynamicModels).toBe("function");
	});
});

describe("gitLabDuoWorkflowModelManagerOptions", () => {
	it("ships the Vertex Sonnet fallback and no fetcher when unauthenticated", () => {
		const options = gitLabDuoWorkflowModelManagerOptions();
		expect(options.providerId).toBe("gitlab-duo-agent");
		expect(options.dynamicModelsAuthoritative).toBe(true);
		expect(options.fetchDynamicModels).toBeUndefined();
		expect(options.staticModels?.map(model => model.id)).toEqual(["claude_sonnet_4_6_vertex"]);
	});

	it("partitions the cache per credential/namespace so two accounts never share a catalog", () => {
		const a = gitLabDuoWorkflowModelManagerOptions({ apiKey: "token-a", namespaceId: "42" });
		const b = gitLabDuoWorkflowModelManagerOptions({ apiKey: "token-b", namespaceId: "42" });
		const c = gitLabDuoWorkflowModelManagerOptions({ apiKey: "token-a", namespaceId: "99" });
		expect(a.cacheProviderId).toStartWith("gitlab-duo-agent:");
		expect(a.cacheProviderId).not.toBe(b.cacheProviderId);
		expect(a.cacheProviderId).not.toBe(c.cacheProviderId);
	});

	it("carries the api key into the GraphQL discovery call", async () => {
		let sawAuth = "";
		let sawUrl = "";
		const spyFetch = (async (url: string | URL | Request, init?: RequestInit) => {
			sawUrl = String(url);
			sawAuth = new Headers(init?.headers).get("Authorization") ?? "";
			return new Response(JSON.stringify({ data: { aiChatAvailableModels: null } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;

		const options = gitLabDuoWorkflowModelManagerOptions({
			apiKey: "glpat-secret",
			namespaceId: "42",
			fetch: spyFetch,
		});
		expect(typeof options.fetchDynamicModels).toBe("function");
		// No candidate namespace surfaces models, so discovery throws — but the
		// credential must already have reached the GitLab API by then (namespace
		// enumeration runs before the per-namespace model GraphQL query).
		await expect(options.fetchDynamicModels?.()).rejects.toThrow(/namespace/i);
		expect(sawUrl).toContain("gitlab.com/api/");
		expect(sawAuth).toBe("Bearer glpat-secret");
	});
});

describe("devinModelManagerOptions", () => {
	it("returns a bare provider config with no fetcher when unauthenticated", () => {
		const options = devinModelManagerOptions();
		expect(options.providerId).toBe("devin");
		expect(options.dynamicModelsAuthoritative).toBeUndefined();
		expect(options.fetchDynamicModels).toBeUndefined();
	});

	it("posts the session token to the Cascade model-config endpoint", async () => {
		let sawUrl = "";
		let sawMethod = "";
		const spyFetch = (async (url: string | URL | Request, init?: RequestInit) => {
			sawUrl = String(url);
			sawMethod = init?.method ?? "";
			return new Response(new Uint8Array(), { status: 200 });
		}) as typeof fetch;

		const options = devinModelManagerOptions({ apiKey: "devin-session", fetch: spyFetch });
		expect(options.dynamicModelsAuthoritative).toBe(true);
		expect(typeof options.fetchDynamicModels).toBe("function");

		// An empty proto body decodes to no configs, so the fetcher resolves to
		// null/[] — the assertion is that the request actually went out.
		await options.fetchDynamicModels?.();
		expect(sawUrl).toContain("/GetCliModelConfigs");
		expect(sawMethod).toBe("POST");
	});
});

describe("zaiModelManagerOptions", () => {
	it("is a fixed static provider with no dynamic discovery", () => {
		const options = zaiModelManagerOptions();
		expect(options.providerId).toBe("zai");
		expect(options.fetchDynamicModels).toBeUndefined();
		expect(options.staticModels).toBeUndefined();
	});
});
