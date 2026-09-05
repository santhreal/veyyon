/**
 * WHY: The model registry originally constructed, policy-patched, merged, and
 * collapsed effort variants across all 4,300+ bundled catalog models eagerly at
 * initialization time. On-demand per-provider model resolution defers
 * construction of unused providers while preserving model reference identity,
 * provider override precedence, and dynamic discovery updates across `find`,
 * `getAvailable`, and `getAll`. Cache-ID extraction must retain persisted
 * namespaces, including endpoint and credential partitioning.
 *
 * What it does not catch: SQLite driver startup latency across external processes.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterOAuthProviders } from "@veyyon/ai/oauth";
import { buildModel } from "@veyyon/catalog/build";
import { writeModelCache } from "@veyyon/catalog/model-cache";
import { PROVIDER_DESCRIPTORS } from "@veyyon/catalog/provider-models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { AuthStorage } from "@veyyon/kernel/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

describe("a model registry resolves providers on demand", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelsPath: string;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-lazy-reg-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.yml");
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	});

	afterEach(() => {
		unregisterOAuthProviders("test://on-demand-registry");
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it.each([
		{ apiKey: "TEST_KEY", gitlab: "gitlab-duo-agent:m0mmx94chno3", openCode: "t2cb2b50op0d" },
		{ apiKey: "", gitlab: "gitlab-duo-agent", openCode: "37p50ys9v9fy9" },
	])("retains persisted cache namespaces for credential '$apiKey'", ({ apiKey, gitlab, openCode }) => {
		const config = {
			baseUrl: "https://cache.example.test/v1/",
			apiKey,
			namespaceId: "team",
			projectId: "project",
			cwd: "/repo",
		};
		const cacheIds = Object.fromEntries(
			PROVIDER_DESCRIPTORS.filter(descriptor => descriptor.resolveCacheProviderId).map(descriptor => [
				descriptor.providerId,
				descriptor.resolveCacheProviderId?.(config),
			]),
		);
		// Literal persisted keys are independent of the shared factory/resolver
		// implementation. A newly scoped provider requires an explicit fixture.
		expect(cacheIds).toEqual({
			cursor: "cursor:max-mode-v3",
			"gitlab-duo-agent": gitlab,
			litellm: "litellm:rich-v4:3camfxhbrhi2i",
			"opencode-go": `opencode-go:models-v1:${openCode}`,
			"opencode-zen": `opencode-zen:models-v1:${openCode}`,
			openrouter: "openrouter:pseudo-api",
			vllm: "vllm:3camfxhbrhi2i",
		});
	});

	it.each([
		{ label: "default endpoint", baseUrl: undefined, apiKey: undefined },
		{ label: "configured endpoint", baseUrl: "https://models.example.test/v1", apiKey: undefined },
		{ label: "authenticated endpoint", baseUrl: "https://models.example.test/v1", apiKey: "TEST_KEY" },
	])("loads every standard discovery cache with its $label", ({ baseUrl, apiKey }) => {
		// Cache namespaces are persisted output shared by discovery and offline
		// startup. A new endpoint-scoped factory must change both consumers.
		const providers: Record<string, { baseUrl?: string; apiKey?: string; auth: "none" | "apiKey" }> = {};
		for (const descriptor of PROVIDER_DESCRIPTORS) {
			const options = descriptor.createModelManagerOptions({
				baseUrl,
				apiKey,
				fetch: async () => {
					throw new Error("Offline cache loading must not access the network");
				},
			});
			const cacheId = options.cacheProviderId ?? options.providerId;
			expect({ provider: descriptor.providerId, cacheId }).toEqual({
				provider: descriptor.providerId,
				cacheId: descriptor.resolveCacheProviderId?.({ baseUrl, apiKey }) ?? descriptor.providerId,
			});
			providers[descriptor.providerId] = {
				baseUrl,
				apiKey: apiKey ? `literal:${apiKey}` : undefined,
				auth: apiKey ? "apiKey" : "none",
			};
			// Startup does not resolve credentials while reading persisted metadata.
			const startupOptions = apiKey === undefined ? options : descriptor.createModelManagerOptions({ baseUrl });
			writeModelCache(
				startupOptions.cacheProviderId ?? startupOptions.providerId,
				Date.now(),
				[
					buildModel({
						id: "cached-namespace-record",
						name: "Cached namespace record",
						provider: descriptor.providerId,
						api: "openai-completions",
						baseUrl: "https://cached.example.test/v1",
						contextWindow: 31_000,
						maxTokens: 4_000,
						input: ["text"],
						reasoning: false,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					}),
				],
				false,
				"namespace-contract",
				path.join(tempDir, "models.db"),
			);
		}
		fs.writeFileSync(modelsPath, JSON.stringify({ providers }));
		const registry = new ModelRegistry(authStorage, modelsPath, { snapshotIo: false });
		expect(registry.getError()).toBeUndefined();
		for (const descriptor of PROVIDER_DESCRIPTORS) {
			const model = registry.find(descriptor.providerId, "cached-namespace-record");
			expect({
				provider: model?.provider,
				contextWindow: model?.contextWindow,
				baseUrl: model?.baseUrl,
			}).toEqual({
				provider: descriptor.providerId,
				contextWindow: 31_000,
				baseUrl: baseUrl ?? "https://cached.example.test/v1",
			});
		}
	});

	it("preserves exact model reference identity between find, getAvailable, and getAll", () => {
		authStorage.setConfigApiKey("anthropic", "test-key");
		const registry = new ModelRegistry(authStorage, modelsPath, { snapshotIo: false });

		const found = registry.find("anthropic", "claude-3-7-sonnet-20250219");
		expect(found).toBeDefined();

		const available = registry.getAvailable();
		const availableModel = available.find(m => m.provider === "anthropic" && m.id === "claude-3-7-sonnet-20250219");
		expect(availableModel).toBe(found);

		const all = registry.getAll();
		const allModel = all.find(m => m.provider === "anthropic" && m.id === "claude-3-7-sonnet-20250219");
		expect(allModel).toBe(found);
	});

	it("applies provider and model overrides when resolving a provider on demand", () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					anthropic: {
						baseUrl: "https://custom.anthropic.example.com/v1",
						modelOverrides: {
							"claude-3-7-sonnet-20250219": {
								contextWindow: 500_000,
							},
						},
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath, { snapshotIo: false });
		const model = registry.find("anthropic", "claude-3-7-sonnet-20250219");

		expect(model).toBeDefined();
		expect(model?.baseUrl).toBe("https://custom.anthropic.example.com/v1");
		expect(model?.contextWindow).toBe(500_000);
	});

	it("updates provider reported context window without breaking model lookup", () => {
		authStorage.setConfigApiKey("anthropic", "test-key");
		const registry = new ModelRegistry(authStorage, modelsPath, { snapshotIo: false });

		const initial = registry.find("anthropic", "claude-3-7-sonnet-20250219");
		expect(initial).toBeDefined();

		const changed = registry.recordProviderReportedContextWindow("anthropic", "claude-3-7-sonnet-20250219", 250_000);
		expect(changed).toBe(true);

		const updated = registry.find("anthropic", "claude-3-7-sonnet-20250219");
		expect(updated?.contextWindow).toBe(250_000);

		const all = registry.getAll();
		const updatedInAll = all.find(m => m.provider === "anthropic" && m.id === "claude-3-7-sonnet-20250219");
		expect(updatedInAll?.contextWindow).toBe(250_000);
	});

	it("getAvailable returns only keyless or authenticated providers", () => {
		authStorage.setConfigApiKey("anthropic", "test-key");
		const registry = new ModelRegistry(authStorage, modelsPath, { snapshotIo: false });

		const available = registry.getAvailable();
		const providers = new Set(available.map(m => m.provider));

		expect(providers.has("anthropic")).toBe(true);
		// Unauthenticated providers must not appear in available
		expect(providers.has("groq")).toBe(false);
		expect(providers.has("openrouter")).toBe(false);
	});

	it("getProviderBaseUrl returns undefined for nonexistent providers and returns model baseUrl", () => {
		const registry = new ModelRegistry(authStorage, modelsPath, { snapshotIo: false });

		// Nonexistent provider must return undefined
		expect(registry.getProviderBaseUrl("nonexistent-provider-xyz")).toBeUndefined();

		// Existing provider returns its first model's baseUrl
		expect(registry.getProviderBaseUrl("anthropic")).toBe("https://api.anthropic.com");
	});

	it("retains registered wire variants until an offline refresh collapses their family", async () => {
		const registry = new ModelRegistry(authStorage, modelsPath, { snapshotIo: false });

		registry.registerProvider("test-variant-provider", {
			baseUrl: "https://variant.example.com/v1",
			apiKey: "literal:TEST_KEY",
			api: "openai-completions",
			models: [
				{
					id: "test-model",
					name: "Test Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
				{
					id: "test-model-thinking",
					name: "Test Model Reasoning",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
		});

		// Immediate view before refresh
		const immediate = registry.find("test-variant-provider", "test-model");
		expect(immediate).toBeDefined();
		expect(immediate?.id).toBe("test-model");
		expect(
			registry
				.getAll()
				.filter(model => model.provider === "test-variant-provider")
				.map(model => model.id),
		).toEqual(["test-model", "test-model-thinking"]);

		// View after refresh
		await registry.refresh("offline");
		const refreshed = registry.find("test-variant-provider", "test-model");
		expect(refreshed).toBeDefined();
		expect(refreshed?.id).toBe("test-model");
		expect(refreshed?.contextWindow).toBe(128000);
		expect(
			registry
				.getAll()
				.filter(model => model.provider === "test-variant-provider")
				.map(model => model.id),
		).toEqual(["test-model"]);
	});

	it("registerProvider oauth.modifyModels receives prewarmed catalog with new models, rewrites unrelated models, and respects removal", async () => {
		await authStorage.set("test-oauth-provider", {
			type: "oauth",
			access: "test-token",
			refresh: "test-refresh",
			expires: Date.now() + 100000,
		});

		const registry = new ModelRegistry(authStorage, modelsPath, { snapshotIo: false });
		// Prewarm getAll before registration
		const prewarmed = registry.getAll();
		expect(prewarmed.length).toBeGreaterThan(100);

		let receivedModelList: Array<{ provider: string; id: string }> = [];
		registry.registerProvider(
			"test-oauth-provider",
			{
				baseUrl: "https://oauth.example.com/v1",
				apiKey: "literal:TEST_KEY",
				api: "openai-completions",
				models: [
					{
						id: "oauth-model",
						name: "OAuth Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 100_000,
						maxTokens: 4096,
					},
				],
				oauth: {
					name: "Test OAuth",
					login: async () => "test-token",
					modifyModels: models => {
						receivedModelList = models.map(m => ({ provider: m.provider, id: m.id }));
						return models
							.filter(m => !(m.provider === "anthropic" && m.id === "claude-3-opus-20240229"))
							.map(m => {
								if (m.provider === "openai" && m.id === "gpt-4o") {
									return { ...m, contextWindow: 777_777 };
								}
								if (m.provider === "test-oauth-provider" && m.id === "oauth-model") {
									return { ...m, contextWindow: 999_999 };
								}
								return m;
							});
					},
				},
			},
			"test://on-demand-registry",
		);

		// Verify newly registered model was included in modifyModels input
		expect(receivedModelList.some(m => m.provider === "test-oauth-provider" && m.id === "oauth-model")).toBe(true);
		// Verify unrelated model was included in modifyModels input
		expect(receivedModelList.some(m => m.provider === "openai" && m.id === "gpt-4o")).toBe(true);

		// Verify unrelated model rewrite
		const modifiedUnrelated = registry.find("openai", "gpt-4o");
		expect(modifiedUnrelated?.contextWindow).toBe(777_777);

		// Verify newly registered model rewrite
		const modifiedNew = registry.find("test-oauth-provider", "oauth-model");
		expect(modifiedNew?.contextWindow).toBe(999_999);

		// Verify removed model is not found and not regenerated
		const removedModel = registry.find("anthropic", "claude-3-opus-20240229");
		expect(removedModel).toBeUndefined();

		// Verify OAuth deletion survives an unrelated provider's context-window update
		registry.recordProviderReportedContextWindow("openai", "gpt-4o", 250_000);
		expect(registry.find("openai", "gpt-4o")?.contextWindow).toBe(250_000);
		expect(registry.find("anthropic", "claude-3-opus-20240229")).toBeUndefined();

		registry.registerProvider("openai", { baseUrl: "https://transport.example.com/v1" });
		expect(registry.find("openai", "gpt-4o")?.baseUrl).toBe("https://transport.example.com/v1");
		expect(registry.find("anthropic", "claude-3-opus-20240229")).toBeUndefined();

		registry.registerProvider("discovered-provider", {
			baseUrl: "https://discovery.example.com/v1",
			api: "openai-completions",
			apiKey: "literal:TEST_KEY",
			fetchDynamicModels: async () => [
				{
					id: "discovered-model",
					name: "Discovered Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32_000,
					maxTokens: 4_096,
				},
			],
		});
		await registry.refreshRuntimeProviders("online", "discovered-provider");
		expect(registry.find("discovered-provider", "discovered-model")?.contextWindow).toBe(32_000);
		expect(registry.find("anthropic", "claude-3-opus-20240229")).toBeUndefined();
		expect(
			registry.getAll().some(model => model.provider === "anthropic" && model.id === "claude-3-opus-20240229"),
		).toBe(false);
	});

	it("authoritative discovery drops obsolete models on refresh when upstream removes them", async () => {
		let liveModels = [
			{
				id: "authoritative-model-1",
				name: "Model 1",
				reasoning: false,
				input: ["text" as const],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
			{
				id: "authoritative-model-2",
				name: "Model 2",
				reasoning: false,
				input: ["text" as const],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		];

		const registry = new ModelRegistry(authStorage, modelsPath, { snapshotIo: false });
		registry.registerProvider("dynamic-auth-provider", {
			baseUrl: "https://dynamic.example.com/v1",
			apiKey: "literal:TEST_KEY",
			api: "openai-completions",
			fetchDynamicModels: async () => liveModels,
		});

		// First refresh: both models are discovered
		await registry.refresh("online");
		expect(registry.find("dynamic-auth-provider", "authoritative-model-1")).toBeDefined();
		expect(registry.find("dynamic-auth-provider", "authoritative-model-2")).toBeDefined();

		// Upstream removes model-1, keeping only model-2
		liveModels = [liveModels[1]!];
		await registry.refresh("online");

		// model-1 must be dropped, model-2 must remain
		expect(registry.find("dynamic-auth-provider", "authoritative-model-1")).toBeUndefined();
		expect(registry.find("dynamic-auth-provider", "authoritative-model-2")).toBeDefined();
	});

	it("preserves exact global layer ordering between bundled, custom config, and runtime models", () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-config-provider": {
						baseUrl: "https://custom.example.com/v1",
						api: "openai-completions",
						apiKey: "test-key",
						models: [
							{
								id: "config-model-1",
								name: "Config Model 1",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 64000,
								maxTokens: 4096,
							},
						],
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath, { snapshotIo: false });
		registry.registerProvider("runtime-registered-provider", {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "literal:TEST_KEY",
			api: "openai-completions",
			models: [
				{
					id: "runtime-model-1",
					name: "Runtime Model 1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
		});

		const all = registry.getAll();
		const ids = all.map(m => `${m.provider}/${m.id}`);

		// Bundled anthropic model appears first
		const anthropicIdx = ids.indexOf("anthropic/claude-3-5-sonnet-20241022");
		// Custom config model is appended after bundled models
		const configIdx = ids.indexOf("custom-config-provider/config-model-1");
		// Runtime registered model is appended after custom config models
		const runtimeIdx = ids.indexOf("runtime-registered-provider/runtime-model-1");

		expect(anthropicIdx).toBeGreaterThanOrEqual(0);
		expect(configIdx).toBeGreaterThan(anthropicIdx);
		expect(runtimeIdx).toBeGreaterThan(configIdx);
	});

	it("preserves exact model reference identity across find -> getAvailable -> getAll -> unrelated change -> find", () => {
		authStorage.setConfigApiKey("anthropic", "test-key");
		authStorage.setConfigApiKey("openai", "test-key");
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					anthropic: {
						baseUrl: "https://override.example.com/v1",
						modelOverrides: {
							"claude-3-7-sonnet-20250219": { contextWindow: 450_000 },
						},
					},
				},
			}),
		);
		const registry = new ModelRegistry(authStorage, modelsPath, { snapshotIo: false });

		// 1. Initial targeted find
		const found = registry.find("anthropic", "claude-3-7-sonnet-20250219");
		expect(found).toBeDefined();
		expect(found?.baseUrl).toBe("https://override.example.com/v1");
		expect(found?.contextWindow).toBe(450_000);

		// 2. getAvailable
		const available = registry.getAvailable();
		const availableModel = available.find(m => m.provider === "anthropic" && m.id === "claude-3-7-sonnet-20250219");
		expect(availableModel).toBe(found);

		// 3. getAll
		const all = registry.getAll();
		const allModel = all.find(m => m.provider === "anthropic" && m.id === "claude-3-7-sonnet-20250219");
		expect(allModel).toBe(found);

		// 4. Unrelated provider context window change
		registry.recordProviderReportedContextWindow("openai", "gpt-4o", 500_000);
		const openaiModel = registry.find("openai", "gpt-4o");
		expect(openaiModel?.contextWindow).toBe(500_000);

		// 5. Find again on anthropic model — must maintain identical reference
		const foundAgain = registry.find("anthropic", "claude-3-7-sonnet-20250219");
		expect(foundAgain).toBe(found);
	});

	it("preserves global layer order in getAvailable when custom model is added to an existing early bundled provider", () => {
		authStorage.setConfigApiKey("anthropic", "test-key");
		authStorage.setConfigApiKey("openai", "test-key");

		// Add a custom model to "anthropic" (an early bundled provider)
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					anthropic: {
						baseUrl: "https://api.anthropic.com",
						api: "anthropic-messages",
						apiKey: "test-key",
						models: [
							{
								id: "custom-anthropic-model",
								name: "Custom Anthropic Model",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 128000,
								maxTokens: 8192,
							},
						],
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath, { snapshotIo: false });
		const available = registry.getAvailable();
		const ids = available.map(m => `${m.provider}/${m.id}`);

		// Bundled anthropic model
		const anthropicBundledIdx = ids.indexOf("anthropic/claude-3-5-sonnet-20241022");
		// Custom anthropic model (appended after the bundled anthropic models)
		const customAnthropicIdx = ids.indexOf("anthropic/custom-anthropic-model");
		// Bundled openai model (a later authenticated provider)
		const openaiBundledIdx = ids.indexOf("openai/gpt-4o");

		expect(anthropicBundledIdx).toBeGreaterThanOrEqual(0);
		expect(customAnthropicIdx).toBeGreaterThan(anthropicBundledIdx);
		expect(openaiBundledIdx).toBeGreaterThan(customAnthropicIdx);
	});
});
