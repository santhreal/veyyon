import { describe, expect, it } from "bun:test";
import {
	allowsUnauthenticatedCatalogDiscovery,
	type CatalogProviderDescriptor,
	isCatalogDescriptor,
	type ProviderDescriptor,
} from "../src/provider-models/descriptor-types";

function makeDescriptor(overrides: Partial<ProviderDescriptor> = {}): ProviderDescriptor {
	return {
		providerId: "test",
		createModelManagerOptions: () => ({ providerId: "test" }),
		defaultModel: "test-model",
		...overrides,
	};
}

function makeCatalogDescriptor(overrides: Partial<CatalogProviderDescriptor> = {}): CatalogProviderDescriptor {
	return {
		...makeDescriptor(),
		catalogDiscovery: { label: "Test" },
		...overrides,
	};
}

describe("isCatalogDescriptor", () => {
	it("returns true when catalogDiscovery is present", () => {
		expect(isCatalogDescriptor(makeCatalogDescriptor())).toBe(true);
	});
	it("returns false when catalogDiscovery is absent", () => {
		expect(isCatalogDescriptor(makeDescriptor())).toBe(false);
	});
	it("returns false when catalogDiscovery is undefined", () => {
		expect(isCatalogDescriptor(makeDescriptor({ catalogDiscovery: undefined }))).toBe(false);
	});
	it("returns false when catalogDiscovery is null", () => {
		expect(isCatalogDescriptor(makeDescriptor({ catalogDiscovery: null as unknown as undefined }))).toBe(false);
	});
});

describe("allowsUnauthenticatedCatalogDiscovery", () => {
	it("returns true when catalogDiscovery.allowUnauthenticated is true", () => {
		const d = makeCatalogDescriptor({
			catalogDiscovery: { label: "Test", allowUnauthenticated: true },
		});
		expect(allowsUnauthenticatedCatalogDiscovery(d)).toBe(true);
	});
	it("returns true when descriptor.allowUnauthenticated is true and catalogDiscovery.allowUnauthenticated is absent", () => {
		const d = makeCatalogDescriptor({
			allowUnauthenticated: true,
			catalogDiscovery: { label: "Test" },
		});
		expect(allowsUnauthenticatedCatalogDiscovery(d)).toBe(true);
	});
	it("returns false when neither allowUnauthenticated is set", () => {
		const d = makeCatalogDescriptor({
			catalogDiscovery: { label: "Test" },
		});
		expect(allowsUnauthenticatedCatalogDiscovery(d)).toBe(false);
	});
	it("catalogDiscovery.allowUnauthenticated takes precedence over descriptor.allowUnauthenticated", () => {
		const d = makeCatalogDescriptor({
			allowUnauthenticated: true,
			catalogDiscovery: { label: "Test", allowUnauthenticated: false },
		});
		expect(allowsUnauthenticatedCatalogDiscovery(d)).toBe(false);
	});
	it("returns false when both are false", () => {
		const d = makeCatalogDescriptor({
			allowUnauthenticated: false,
			catalogDiscovery: { label: "Test", allowUnauthenticated: false },
		});
		expect(allowsUnauthenticatedCatalogDiscovery(d)).toBe(false);
	});
});
