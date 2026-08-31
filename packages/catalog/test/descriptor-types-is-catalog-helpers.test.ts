import { describe, expect, it } from "bun:test";
import {
	allowsUnauthenticatedCatalogDiscovery,
	type CatalogProviderDescriptor,
	isCatalogDescriptor,
	type ProviderDescriptor,
} from "../src/provider-models/descriptor-types";

function makeDescriptor(overrides: Partial<ProviderDescriptor> & { providerId: string }): ProviderDescriptor {
	return {
		defaultModel: "default-model",
		createModelManagerOptions: () => ({ providerId: overrides.providerId }),
		...overrides,
	};
}

describe("isCatalogDescriptor", () => {
	it("returns true when catalogDiscovery is defined", () => {
		const d = makeDescriptor({
			providerId: "test",
			catalogDiscovery: { label: "Test" },
		});
		expect(isCatalogDescriptor(d)).toBe(true);
	});
	it("returns false when catalogDiscovery is undefined", () => {
		const d = makeDescriptor({ providerId: "test" });
		expect(isCatalogDescriptor(d)).toBe(false);
	});
	it("returns false when catalogDiscovery is null", () => {
		const d = makeDescriptor({ providerId: "test", catalogDiscovery: null as unknown as undefined });
		expect(isCatalogDescriptor(d)).toBe(false);
	});
});

describe("allowsUnauthenticatedCatalogDiscovery", () => {
	it("returns true when catalogDiscovery.allowUnauthenticated is true", () => {
		const d: CatalogProviderDescriptor = {
			providerId: "test",
			defaultModel: "default",
			createModelManagerOptions: () => ({ providerId: "test" }),
			catalogDiscovery: { label: "Test", allowUnauthenticated: true },
		};
		expect(allowsUnauthenticatedCatalogDiscovery(d)).toBe(true);
	});
	it("returns false when catalogDiscovery.allowUnauthenticated is false", () => {
		const d: CatalogProviderDescriptor = {
			providerId: "test",
			defaultModel: "default",
			createModelManagerOptions: () => ({ providerId: "test" }),
			catalogDiscovery: { label: "Test", allowUnauthenticated: false },
		};
		expect(allowsUnauthenticatedCatalogDiscovery(d)).toBe(false);
	});
	it("falls back to descriptor.allowUnauthenticated when catalogDiscovery.allowUnauthenticated is undefined", () => {
		const d: CatalogProviderDescriptor = {
			providerId: "test",
			defaultModel: "default",
			createModelManagerOptions: () => ({ providerId: "test" }),
			allowUnauthenticated: true,
			catalogDiscovery: { label: "Test" },
		};
		expect(allowsUnauthenticatedCatalogDiscovery(d)).toBe(true);
	});
	it("returns false when neither allowUnauthenticated is set", () => {
		const d: CatalogProviderDescriptor = {
			providerId: "test",
			defaultModel: "default",
			createModelManagerOptions: () => ({ providerId: "test" }),
			catalogDiscovery: { label: "Test" },
		};
		expect(allowsUnauthenticatedCatalogDiscovery(d)).toBe(false);
	});
	it("catalogDiscovery.allowUnauthenticated takes priority over descriptor.allowUnauthenticated", () => {
		const d: CatalogProviderDescriptor = {
			providerId: "test",
			defaultModel: "default",
			createModelManagerOptions: () => ({ providerId: "test" }),
			allowUnauthenticated: true,
			catalogDiscovery: { label: "Test", allowUnauthenticated: false },
		};
		expect(allowsUnauthenticatedCatalogDiscovery(d)).toBe(false);
	});
});
