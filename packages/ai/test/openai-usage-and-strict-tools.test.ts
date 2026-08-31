import { describe, expect, it } from "bun:test";
import {
	calculateOpenAIUsageAccounting,
	clearOpenAIStrictToolsState,
	createOpenAIStrictToolsState,
	disableStrictToolsForScope,
	getOpenAIStrictToolsScope,
	isStrictToolsDisabledForScope,
	type OpenAIModelIdentity,
	parseAzureDeploymentNameMap,
} from "../src/providers/openai-shared";

describe("calculateOpenAIUsageAccounting", () => {
	it("calculates basic usage with no cache", () => {
		const result = calculateOpenAIUsageAccounting({
			promptTokens: 100,
			outputTokens: 50,
			cachedTokens: 0,
			reasoningTokens: 0,
			cacheWriteOpenRouter: undefined,
			cacheWriteDeepSeek: undefined,
			hasDeepSeekCacheHitAndMiss: false,
		});
		expect(result.input).toBe(100);
		expect(result.output).toBe(50);
		expect(result.cacheRead).toBe(0);
		expect(result.cacheWrite).toBe(0);
		expect(result.totalTokens).toBe(150);
		expect(result.reasoningTokens).toBeUndefined();
	});

	it("subtracts cached tokens from input", () => {
		const result = calculateOpenAIUsageAccounting({
			promptTokens: 100,
			outputTokens: 50,
			cachedTokens: 30,
			reasoningTokens: 0,
			cacheWriteOpenRouter: undefined,
			cacheWriteDeepSeek: undefined,
			hasDeepSeekCacheHitAndMiss: false,
		});
		expect(result.input).toBe(70);
		expect(result.cacheRead).toBe(30);
		expect(result.totalTokens).toBe(150);
	});

	it("subtracts cacheWriteOpenRouter from input", () => {
		const result = calculateOpenAIUsageAccounting({
			promptTokens: 100,
			outputTokens: 50,
			cachedTokens: 0,
			reasoningTokens: 0,
			cacheWriteOpenRouter: 20,
			cacheWriteDeepSeek: undefined,
			hasDeepSeekCacheHitAndMiss: false,
		});
		expect(result.input).toBe(80);
		expect(result.cacheWrite).toBe(20);
		expect(result.totalTokens).toBe(150);
	});

	it("uses cacheWriteDeepSeek when cacheWriteOpenRouter is undefined", () => {
		const result = calculateOpenAIUsageAccounting({
			promptTokens: 100,
			outputTokens: 50,
			cachedTokens: 0,
			reasoningTokens: 0,
			cacheWriteOpenRouter: undefined,
			cacheWriteDeepSeek: 15,
			hasDeepSeekCacheHitAndMiss: false,
		});
		expect(result.input).toBe(85);
		expect(result.cacheWrite).toBe(15);
	});

	it("prefers cacheWriteOpenRouter over cacheWriteDeepSeek", () => {
		const result = calculateOpenAIUsageAccounting({
			promptTokens: 100,
			outputTokens: 50,
			cachedTokens: 0,
			reasoningTokens: 0,
			cacheWriteOpenRouter: 20,
			cacheWriteDeepSeek: 15,
			hasDeepSeekCacheHitAndMiss: false,
		});
		expect(result.cacheWrite).toBe(20);
		expect(result.input).toBe(80);
	});

	it("DeepSeek mode does not subtract cacheWrite from input", () => {
		const result = calculateOpenAIUsageAccounting({
			promptTokens: 100,
			outputTokens: 50,
			cachedTokens: 30,
			reasoningTokens: 0,
			cacheWriteOpenRouter: undefined,
			cacheWriteDeepSeek: 20,
			hasDeepSeekCacheHitAndMiss: true,
		});
		expect(result.input).toBe(70);
		expect(result.cacheWrite).toBe(0);
	});

	it("DeepSeek mode requires hasDeepSeekCacheHitAndMiss to be true", () => {
		const result = calculateOpenAIUsageAccounting({
			promptTokens: 100,
			outputTokens: 50,
			cachedTokens: 30,
			reasoningTokens: 0,
			cacheWriteOpenRouter: undefined,
			cacheWriteDeepSeek: 20,
			hasDeepSeekCacheHitAndMiss: false,
		});
		// Not DeepSeek mode, so cacheWrite is subtracted from input
		expect(result.input).toBe(50);
		expect(result.cacheWrite).toBe(20);
	});

	it("DeepSeek mode requires cacheWriteOpenRouter to be undefined", () => {
		const result = calculateOpenAIUsageAccounting({
			promptTokens: 100,
			outputTokens: 50,
			cachedTokens: 30,
			reasoningTokens: 0,
			cacheWriteOpenRouter: 10,
			cacheWriteDeepSeek: 20,
			hasDeepSeekCacheHitAndMiss: true,
		});
		// Not DeepSeek mode because cacheWriteOpenRouter is defined
		expect(result.cacheWrite).toBe(10);
	});

	it("includes reasoningTokens when > 0", () => {
		const result = calculateOpenAIUsageAccounting({
			promptTokens: 100,
			outputTokens: 50,
			cachedTokens: 0,
			reasoningTokens: 25,
			cacheWriteOpenRouter: undefined,
			cacheWriteDeepSeek: undefined,
			hasDeepSeekCacheHitAndMiss: false,
		});
		expect(result.reasoningTokens).toBe(25);
	});

	it("excludes reasoningTokens when 0", () => {
		const result = calculateOpenAIUsageAccounting({
			promptTokens: 100,
			outputTokens: 50,
			cachedTokens: 0,
			reasoningTokens: 0,
			cacheWriteOpenRouter: undefined,
			cacheWriteDeepSeek: undefined,
			hasDeepSeekCacheHitAndMiss: false,
		});
		expect(result.reasoningTokens).toBeUndefined();
	});

	it("clamps input to 0 when cache exceeds prompt", () => {
		const result = calculateOpenAIUsageAccounting({
			promptTokens: 10,
			outputTokens: 50,
			cachedTokens: 30,
			reasoningTokens: 0,
			cacheWriteOpenRouter: 5,
			cacheWriteDeepSeek: undefined,
			hasDeepSeekCacheHitAndMiss: false,
		});
		expect(result.input).toBe(0);
	});

	it("calculates totalTokens correctly with all components", () => {
		const result = calculateOpenAIUsageAccounting({
			promptTokens: 200,
			outputTokens: 100,
			cachedTokens: 50,
			reasoningTokens: 0,
			cacheWriteOpenRouter: 30,
			cacheWriteDeepSeek: undefined,
			hasDeepSeekCacheHitAndMiss: false,
		});
		expect(result.input).toBe(120);
		expect(result.totalTokens).toBe(120 + 100 + 50 + 30);
	});
});

describe("parseAzureDeploymentNameMap", () => {
	it("returns empty map for undefined", () => {
		expect(parseAzureDeploymentNameMap(undefined).size).toBe(0);
	});

	it("returns empty map for empty string", () => {
		expect(parseAzureDeploymentNameMap("").size).toBe(0);
	});

	it("parses single entry", () => {
		const map = parseAzureDeploymentNameMap("gpt-4=my-deployment");
		expect(map.get("gpt-4")).toBe("my-deployment");
	});

	it("parses multiple entries", () => {
		const map = parseAzureDeploymentNameMap("gpt-4=dep1,claude=dep2");
		expect(map.get("gpt-4")).toBe("dep1");
		expect(map.get("claude")).toBe("dep2");
	});

	it("trims whitespace in keys and values", () => {
		const map = parseAzureDeploymentNameMap("  gpt-4  =  my-dep  ");
		expect(map.get("gpt-4")).toBe("my-dep");
	});

	it("skips entries without =", () => {
		const map = parseAzureDeploymentNameMap("gpt-4,invalid");
		expect(map.size).toBe(0);
	});

	it("skips entries with empty key", () => {
		const map = parseAzureDeploymentNameMap("=dep");
		expect(map.size).toBe(0);
	});

	it("skips entries with empty value", () => {
		const map = parseAzureDeploymentNameMap("gpt-4=");
		expect(map.size).toBe(0);
	});

	it("skips empty entries between commas", () => {
		const map = parseAzureDeploymentNameMap("gpt-4=dep,,claude=dep2,");
		expect(map.size).toBe(2);
	});

	it("handles value containing = (split limit 2)", () => {
		const map = parseAzureDeploymentNameMap("model=name=value");
		// split("=", 2) produces ["model", "name=value"]? No, split with limit 2 gives ["model", "name=value"]
		// Actually split("=", 2) in JS gives ["model", "name"] — the limit limits the array length
		// but the second element is the rest joined
		// Actually no: "model=name=value".split("=", 2) => ["model", "name"]
		expect(map.get("model")).toBe("name");
	});
});

describe("createOpenAIStrictToolsState", () => {
	it("returns state with empty disabledModelScopes set", () => {
		const state = createOpenAIStrictToolsState();
		expect(state.strictTools.disabledModelScopes).toBeInstanceOf(Set);
		expect(state.strictTools.disabledModelScopes.size).toBe(0);
	});
});

describe("clearOpenAIStrictToolsState", () => {
	it("clears the disabledModelScopes set", () => {
		const state = createOpenAIStrictToolsState();
		state.strictTools.disabledModelScopes.add("test");
		clearOpenAIStrictToolsState(state);
		expect(state.strictTools.disabledModelScopes.size).toBe(0);
	});

	it("works on already-empty state", () => {
		const state = createOpenAIStrictToolsState();
		expect(() => clearOpenAIStrictToolsState(state)).not.toThrow();
	});
});

describe("getOpenAIStrictToolsScope", () => {
	it("creates scope from model identity", () => {
		const model: OpenAIModelIdentity = { provider: "openai", id: "gpt-4", baseUrl: "https://api.openai.com" };
		const scope = getOpenAIStrictToolsScope(model, undefined);
		expect(scope).toEqual({
			provider: "openai",
			baseUrl: "https://api.openai.com",
			modelId: "gpt-4",
		});
	});

	it("uses resolvedBaseUrl over model.baseUrl when provided", () => {
		const model: OpenAIModelIdentity = { provider: "openai", id: "gpt-4", baseUrl: "https://api.openai.com" };
		const scope = getOpenAIStrictToolsScope(model, "https://custom.example.com");
		expect(scope.baseUrl).toBe("https://custom.example.com");
	});

	it("uses undefined baseUrl when neither is set", () => {
		const model: OpenAIModelIdentity = { provider: "openai", id: "gpt-4" };
		const scope = getOpenAIStrictToolsScope(model, undefined);
		expect(scope.baseUrl).toBeUndefined();
	});
});

describe("isStrictToolsDisabledForScope", () => {
	it("returns false for undefined scope", () => {
		const state = createOpenAIStrictToolsState();
		expect(isStrictToolsDisabledForScope(state, undefined)).toBe(false);
	});

	it("returns false for undefined state", () => {
		const scope = { provider: "openai", baseUrl: "https://api.openai.com", modelId: "gpt-4" };
		expect(isStrictToolsDisabledForScope(undefined, scope)).toBe(false);
	});

	it("returns false when scope is not in disabled set", () => {
		const state = createOpenAIStrictToolsState();
		const scope = { provider: "openai", baseUrl: "https://api.openai.com", modelId: "gpt-4" };
		expect(isStrictToolsDisabledForScope(state, scope)).toBe(false);
	});

	it("returns true when scope is in disabled set", () => {
		const state = createOpenAIStrictToolsState();
		const scope = { provider: "openai", baseUrl: "https://api.openai.com", modelId: "gpt-4" };
		disableStrictToolsForScope(state, scope);
		expect(isStrictToolsDisabledForScope(state, scope)).toBe(true);
	});

	it("uses correct key format provider:baseUrl:modelId", () => {
		const state = createOpenAIStrictToolsState();
		const scope = { provider: "openai", baseUrl: "https://api.openai.com", modelId: "gpt-4" };
		disableStrictToolsForScope(state, scope);
		expect(state.strictTools.disabledModelScopes.has("openai:https://api.openai.com:gpt-4")).toBe(true);
	});

	it("handles undefined baseUrl in scope", () => {
		const state = createOpenAIStrictToolsState();
		const scope = { provider: "openai", baseUrl: undefined, modelId: "gpt-4" };
		disableStrictToolsForScope(state, scope);
		expect(isStrictToolsDisabledForScope(state, scope)).toBe(true);
		expect(state.strictTools.disabledModelScopes.has("openai::gpt-4")).toBe(true);
	});

	it("different scopes are independent", () => {
		const state = createOpenAIStrictToolsState();
		const scope1 = { provider: "openai", baseUrl: "https://api.openai.com", modelId: "gpt-4" };
		const scope2 = { provider: "openai", baseUrl: "https://api.openai.com", modelId: "gpt-3.5" };
		disableStrictToolsForScope(state, scope1);
		expect(isStrictToolsDisabledForScope(state, scope1)).toBe(true);
		expect(isStrictToolsDisabledForScope(state, scope2)).toBe(false);
	});
});

describe("disableStrictToolsForScope", () => {
	it("does nothing for undefined scope", () => {
		const state = createOpenAIStrictToolsState();
		disableStrictToolsForScope(state, undefined);
		expect(state.strictTools.disabledModelScopes.size).toBe(0);
	});

	it("does nothing for undefined state", () => {
		const scope = { provider: "openai", baseUrl: "https://api.openai.com", modelId: "gpt-4" };
		expect(() => disableStrictToolsForScope(undefined, scope)).not.toThrow();
	});

	it("adds scope key to disabled set", () => {
		const state = createOpenAIStrictToolsState();
		const scope = { provider: "openai", baseUrl: "https://api.openai.com", modelId: "gpt-4" };
		disableStrictToolsForScope(state, scope);
		expect(state.strictTools.disabledModelScopes.size).toBe(1);
	});

	it("is idempotent (adding same scope twice)", () => {
		const state = createOpenAIStrictToolsState();
		const scope = { provider: "openai", baseUrl: "https://api.openai.com", modelId: "gpt-4" };
		disableStrictToolsForScope(state, scope);
		disableStrictToolsForScope(state, scope);
		expect(state.strictTools.disabledModelScopes.size).toBe(1);
	});
});
