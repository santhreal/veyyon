import { describe, expect, it } from "bun:test";
import { getBundledModels } from "../src/models";
import {
	createBundledReferenceMap,
	createReferenceResolver,
	toModelSpec,
} from "../src/provider-models/bundled-references";
import type { Api, Model } from "../src/types";

describe("toModelSpec", () => {
	it("moves compatConfig to compat", () => {
		const model = {
			id: "test-model",
			provider: "test",
			api: "openai-completions" as Api,
			compatConfig: { some: "config" },
		} as unknown as Model<Api>;
		const spec = toModelSpec(model);
		expect(spec.compat).toEqual({ some: "config" });
	});
	it("removes compatConfig from rest", () => {
		const model = {
			id: "test-model",
			provider: "test",
			api: "openai-completions" as Api,
			compatConfig: { some: "config" },
		} as unknown as Model<Api>;
		const spec = toModelSpec(model);
		expect((spec as unknown as Record<string, unknown>).compatConfig).toBeUndefined();
	});
	it("preserves id and provider", () => {
		const model = {
			id: "test-model",
			provider: "test",
			api: "openai-completions" as Api,
			compatConfig: {},
		} as unknown as Model<Api>;
		const spec = toModelSpec(model);
		expect(spec.id).toBe("test-model");
		expect(spec.provider).toBe("test");
	});
	it("handles undefined compatConfig", () => {
		const model = {
			id: "test-model",
			provider: "test",
			api: "openai-completions" as Api,
		} as unknown as Model<Api>;
		const spec = toModelSpec(model);
		expect(spec.compat).toBeUndefined();
	});
});

describe("createBundledReferenceMap", () => {
	it("returns a Map with entries for openai", () => {
		const map = createBundledReferenceMap<Api>("openai");
		expect(map instanceof Map).toBe(true);
		expect(map.size).toBeGreaterThan(0);
	});
	it("every value has an id matching its key", () => {
		const map = createBundledReferenceMap<Api>("openai");
		for (const [id, spec] of map) {
			expect(spec.id).toBe(id);
		}
	});
	it("returns a non-empty Map for anthropic", () => {
		const map = createBundledReferenceMap<Api>("anthropic");
		expect(map.size).toBeGreaterThan(0);
	});
	it("returns a non-empty Map for google", () => {
		const map = createBundledReferenceMap<Api>("google");
		expect(map.size).toBeGreaterThan(0);
	});
});

describe("createReferenceResolver", () => {
	it("returns a function", () => {
		const refs = createBundledReferenceMap<Api>("openai");
		const resolver = createReferenceResolver(refs);
		expect(typeof resolver).toBe("function");
	});
	it("resolves provider-specific model id first", () => {
		const refs = createBundledReferenceMap<Api>("openai");
		const resolver = createReferenceResolver(refs);
		const firstId = refs.keys().next().value;
		if (firstId) {
			const result = resolver(firstId);
			expect(result).toBeDefined();
			expect(result?.id).toBe(firstId);
		}
	});
	it("resolves global model id when not in provider refs", () => {
		const refs = new Map();
		const resolver = createReferenceResolver(refs);
		// Try a well-known model id that should exist in global refs
		const openaiModels = getBundledModels("openai");
		if (openaiModels.length > 0) {
			const result = resolver(openaiModels[0].id);
			expect(result).toBeDefined();
		}
	});
	it("returns undefined for unknown model id", () => {
		const refs = new Map();
		const resolver = createReferenceResolver(refs);
		expect(resolver("nonexistent-model-id-xyz")).toBeUndefined();
	});
	it("returns undefined for empty provider refs and unknown id", () => {
		const refs = new Map();
		const resolver = createReferenceResolver(refs);
		expect(resolver("")).toBeUndefined();
	});
});
