import { describe, expect, it } from "bun:test";
import "../src/usage/defaults";
import type { CredentialRankingStrategy, UsageProvider } from "../src/usage";
import {
	listRegisteredUsageProviders,
	registerUsageProviders,
	resolveRegisteredRankingStrategy,
	resolveRegisteredUsageProvider,
	usageProvidersRegistered,
} from "../src/usage/registry";

// The registry is a module-level singleton already populated by defaults.ts import.
// These tests verify the registry API works correctly with the already-registered providers.

describe("usageProvidersRegistered", () => {
	it("returns true after defaults are loaded", () => {
		// defaults.ts is imported at module load time by the test setup
		expect(usageProvidersRegistered()).toBe(true);
	});
});

describe("resolveRegisteredUsageProvider", () => {
	it("returns a provider for known provider id", () => {
		// openai-codex is registered in defaults
		const provider = resolveRegisteredUsageProvider("openai-codex");
		expect(provider).toBeDefined();
		expect(provider!.id).toBe("openai-codex");
	});
	it("returns undefined for unknown provider", () => {
		expect(resolveRegisteredUsageProvider("nonexistent-provider" as never)).toBeUndefined();
	});
});

describe("resolveRegisteredRankingStrategy", () => {
	it("returns a strategy for known provider", () => {
		const strategy = resolveRegisteredRankingStrategy("openai-codex");
		expect(strategy).toBeDefined();
	});
	it("returns undefined for unknown provider", () => {
		expect(resolveRegisteredRankingStrategy("nonexistent-provider" as never)).toBeUndefined();
	});
});

describe("listRegisteredUsageProviders", () => {
	it("returns a non-empty array", () => {
		const providers = listRegisteredUsageProviders();
		expect(providers.length).toBeGreaterThan(0);
	});
	it("returns array of UsageProvider objects", () => {
		const providers = listRegisteredUsageProviders();
		for (const p of providers) {
			expect(typeof p.id).toBe("string");
			expect(typeof p.fetchUsage).toBe("function");
			expect(typeof p.supports).toBe("function");
		}
	});
});

describe("registerUsageProviders", () => {
	it("can register additional providers", () => {
		const testProvider: UsageProvider = {
			id: "test-provider-extra" as never,
			fetchUsage: async () => null,
			supports: () => false,
		};
		const testStrategy: CredentialRankingStrategy = { rankCredentials: () => [] };
		registerUsageProviders({
			providers: [testProvider],
			rankingStrategies: [["test-provider-extra" as never, testStrategy]],
		});
		expect(resolveRegisteredUsageProvider("test-provider-extra" as never)).toBeDefined();
		expect(resolveRegisteredRankingStrategy("test-provider-extra" as never)).toBeDefined();
	});
	it("overwrites existing provider with same id", () => {
		const original = resolveRegisteredUsageProvider("openai-codex");
		expect(original).toBeDefined();
		const replacement: UsageProvider = {
			id: "openai-codex",
			fetchUsage: async () => null,
			supports: () => false,
		};
		registerUsageProviders({ providers: [replacement], rankingStrategies: [] });
		const after = resolveRegisteredUsageProvider("openai-codex");
		expect(after).toBe(replacement);
	});
});
