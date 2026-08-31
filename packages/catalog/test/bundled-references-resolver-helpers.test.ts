import { describe, expect, it } from "bun:test";
import {
	createBundledReferenceMap,
	createReferenceResolver,
	toModelSpec,
} from "../src/provider-models/bundled-references";
import type { Api, Model } from "../src/types";

function makeModel(id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		provider: "test",
		api: "openai-responses",
		contextWindow: 128_000,
		maxTokens: 16_384,
		compat: {},
		compatConfig: {},
		...overrides,
	} as unknown as Model<Api>;
}

describe("toModelSpec", () => {
	it("converts model to spec with compat from compatConfig", () => {
		const model = makeModel("test-model", { compatConfig: { supportsTools: true } });
		const spec = toModelSpec(model);
		expect(spec.id).toBe("test-model");
		expect(spec.compat).toEqual({ supportsTools: true });
	});
	it("drops compatConfig from spec", () => {
		const model = makeModel("test-model", { compatConfig: { supportsTools: true } });
		const spec = toModelSpec(model as Model<Api>);
		expect((spec as unknown as { compatConfig?: unknown }).compatConfig).toBeUndefined();
	});
	it("preserves id, provider, api", () => {
		const model = makeModel("m1", { provider: "anthropic", api: "anthropic-messages" });
		const spec = toModelSpec(model);
		expect(spec.id).toBe("m1");
		expect(spec.provider).toBe("anthropic");
		expect(spec.api).toBe("anthropic-messages");
	});
	it("preserves contextWindow and maxTokens", () => {
		const model = makeModel("m1", { contextWindow: 200_000, maxTokens: 8192 });
		const spec = toModelSpec(model);
		expect(spec.contextWindow).toBe(200_000);
		expect(spec.maxTokens).toBe(8192);
	});
});

describe("createBundledReferenceMap", () => {
	it("returns a Map for anthropic", () => {
		const refs = createBundledReferenceMap<Api>("anthropic");
		expect(refs).toBeInstanceOf(Map);
		expect(refs.size).toBeGreaterThan(0);
	});
	it("returns a Map for openai", () => {
		const refs = createBundledReferenceMap<Api>("openai");
		expect(refs).toBeInstanceOf(Map);
		expect(refs.size).toBeGreaterThan(0);
	});
	it("returns empty Map for unknown provider", () => {
		const refs = createBundledReferenceMap<Api>("nonexistent-provider");
		expect(refs.size).toBe(0);
	});
	it("each entry has id matching key", () => {
		const refs = createBundledReferenceMap<Api>("anthropic");
		for (const [id, spec] of refs) {
			expect(spec.id).toBe(id);
		}
	});
});

describe("createReferenceResolver", () => {
	it("returns a function", () => {
		const refs = new Map();
		expect(typeof createReferenceResolver(refs)).toBe("function");
	});
	it("resolves from provider refs first", () => {
		const refs = new Map([["test-model", { id: "test-model", provider: "test" }]]);
		const resolver = createReferenceResolver(refs);
		const result = resolver("test-model");
		expect(result).toBeDefined();
		expect(result!.id).toBe("test-model");
	});
	it("returns undefined for unknown model", () => {
		const refs = new Map();
		const resolver = createReferenceResolver(refs);
		expect(resolver("nonexistent-model-xyz")).toBeUndefined();
	});
	it("resolves from global refs when not in provider refs", () => {
		const refs = new Map();
		const resolver = createReferenceResolver(refs);
		// gpt-4o should be in global refs
		const result = resolver("gpt-4o");
		expect(result).toBeDefined();
	});
	it("provider refs take priority over global refs", () => {
		const refs = new Map([
			["gpt-4o", { id: "gpt-4o", provider: "custom" } as unknown as ReturnType<typeof toModelSpec>],
		]);
		const resolver = createReferenceResolver(refs);
		const result = resolver("gpt-4o");
		expect(result).toBeDefined();
		expect(result!.provider).toBe("custom");
	});
});
