import { describe, expect, it } from "bun:test";
import { Effort } from "../src/effort";
import {
	collapseEffortVariantsAcrossProviders,
	deriveThinkingPairFamilies,
	type EffortVariantFamily,
	isVariantCollapsedSpec,
	resolveBareVariantAlias,
	resolveVariantAlias,
	stripEffortTierSuffix,
	VARIANT_COLLAPSE_TABLES,
	type VariantCollapseTable,
	type VariantSpecLike,
} from "../src/variant-collapse";

function makeSpec(overrides: Partial<VariantSpecLike> = {}): VariantSpecLike {
	return {
		id: "test-model",
		provider: "test",
		name: "Test",
		api: "openai",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		contextWindow: 128000,
		maxTokens: 16384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...overrides,
	};
}

describe("stripEffortTierSuffix", () => {
	it("strips -minimal", () => {
		expect(stripEffortTierSuffix("model-minimal")).toBe("model");
	});
	it("strips -low", () => {
		expect(stripEffortTierSuffix("model-low")).toBe("model");
	});
	it("strips -medium", () => {
		expect(stripEffortTierSuffix("model-medium")).toBe("model");
	});
	it("strips -high", () => {
		expect(stripEffortTierSuffix("model-high")).toBe("model");
	});
	it("strips -xhigh", () => {
		expect(stripEffortTierSuffix("model-xhigh")).toBe("model");
	});
	it("strips -max", () => {
		expect(stripEffortTierSuffix("model-max")).toBe("model");
	});
	it("strips -none", () => {
		expect(stripEffortTierSuffix("model-none")).toBe("model");
	});
	it("strips -thinking", () => {
		expect(stripEffortTierSuffix("model-thinking")).toBe("model");
	});
	it("returns undefined when no suffix", () => {
		expect(stripEffortTierSuffix("model")).toBeUndefined();
	});
	it("returns undefined for empty result", () => {
		expect(stripEffortTierSuffix("-high")).toBeUndefined();
	});
	it("does not strip partial suffix", () => {
		expect(stripEffortTierSuffix("model-higher")).toBeUndefined();
	});
});

describe("VARIANT_COLLAPSE_TABLES", () => {
	it("has entries for known providers", () => {
		expect(Object.keys(VARIANT_COLLAPSE_TABLES).length).toBeGreaterThan(0);
	});
	it("every table has families", () => {
		for (const table of Object.values(VARIANT_COLLAPSE_TABLES) as VariantCollapseTable[]) {
			expect(table.families.length).toBeGreaterThan(0);
		}
	});
	it("every family has an id, name, members, routing, and thinking", () => {
		for (const table of Object.values(VARIANT_COLLAPSE_TABLES) as VariantCollapseTable[]) {
			for (const family of table.families) {
				expect(family.id.length).toBeGreaterThan(0);
				expect(family.name.length).toBeGreaterThan(0);
				expect(family.members.length).toBeGreaterThan(0);
				expect(family.routing).toBeDefined();
				expect(family.thinking).toBeDefined();
			}
		}
	});
});

describe("resolveVariantAlias", () => {
	it("returns undefined for unknown provider", () => {
		expect(resolveVariantAlias("unknown-provider", "some-model")).toBeUndefined();
	});
	it("returns undefined for unknown model in known provider", () => {
		const result = resolveVariantAlias("cursor", "nonexistent-model-xyz-12345");
		expect(result).toBeUndefined();
	});
});

describe("resolveBareVariantAlias", () => {
	it("returns undefined for unknown model", () => {
		expect(resolveBareVariantAlias("nonexistent-model-xyz-12345")).toBeUndefined();
	});
});

describe("isVariantCollapsedSpec", () => {
	it("returns false for spec without thinking or requestModelId", () => {
		expect(isVariantCollapsedSpec(makeSpec())).toBe(false);
	});
	it("returns true for spec with effortRouting", () => {
		const spec = makeSpec({
			thinking: { mode: "effort", efforts: [Effort.Low], effortRouting: { low: "test-model-low" } },
		});
		expect(isVariantCollapsedSpec(spec)).toBe(true);
	});
});

describe("deriveThinkingPairFamilies", () => {
	it("returns empty for empty specs", () => {
		expect(deriveThinkingPairFamilies([])).toEqual([]);
	});
	it("returns empty for specs without thinking variants", () => {
		expect(deriveThinkingPairFamilies([makeSpec()])).toEqual([]);
	});
});

describe("collapseEffortVariantsAcrossProviders", () => {
	it("returns empty for empty input", () => {
		expect(collapseEffortVariantsAcrossProviders([])).toEqual([]);
	});
	it("returns specs unchanged when no variant table matches", () => {
		const specs = [makeSpec({ provider: "unknown-provider" })];
		const result = collapseEffortVariantsAcrossProviders(specs);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("test-model");
	});
});

describe("EffortVariantFamily type", () => {
	it("can be constructed as a value", () => {
		const family: EffortVariantFamily = {
			id: "test-family",
			name: "Test Family",
			members: ["test-model-low", "test-model-high"],
			routing: { low: "test-model-low", high: "test-model-high" },
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
		};
		expect(family.id).toBe("test-family");
		expect(family.members).toHaveLength(2);
	});
});
