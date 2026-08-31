import { describe, expect, it } from "bun:test";
import {
	buildModelReferenceIndex,
	isZeroCostXaiOAuthReference,
	resolveModelReference,
} from "../src/identity/reference";
import type { Api, Model } from "../src/types";

function makeModel(overrides: Partial<Model<Api>> & { id: string }): Model<Api> {
	return {
		name: overrides.id,
		api: "openai-completions" as Api,
		provider: "test",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 2048,
		compat: {} as Model<Api>["compat"],
		...overrides,
	};
}

describe("isZeroCostXaiOAuthReference", () => {
	it("returns true for zero-cost xai-oauth model", () => {
		const model = makeModel({ id: "grok-free", provider: "xai-oauth" });
		expect(isZeroCostXaiOAuthReference(model)).toBe(true);
	});
	it("returns false for non-xai-oauth provider", () => {
		const model = makeModel({ id: "gpt-4o", provider: "openai" });
		expect(isZeroCostXaiOAuthReference(model)).toBe(false);
	});
	it("returns false for xai-oauth with non-zero cost", () => {
		const model = makeModel({
			id: "grok-paid",
			provider: "xai-oauth",
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		});
		expect(isZeroCostXaiOAuthReference(model)).toBe(false);
	});
	it("returns false for xai-oauth with input cost only", () => {
		const model = makeModel({
			id: "grok-input",
			provider: "xai-oauth",
			cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		expect(isZeroCostXaiOAuthReference(model)).toBe(false);
	});
});

describe("buildModelReferenceIndex", () => {
	it("builds index with exact references", () => {
		const model = makeModel({ id: "gpt-4o" });
		const index = buildModelReferenceIndex([model]);
		expect(index.exact.get("gpt-4o")).toBe(model);
	});
	it("normalizes keys to lowercase", () => {
		const model = makeModel({ id: "GPT-4o" });
		const index = buildModelReferenceIndex([model]);
		expect(index.exact.get("gpt-4o")).toBe(model);
	});
	it("skips zero-cost xai-oauth models", () => {
		const model = makeModel({ id: "grok-free", provider: "xai-oauth" });
		const index = buildModelReferenceIndex([model]);
		expect(index.exact.size).toBe(0);
	});
	it("builds suffix alias for slashed ids", () => {
		const model = makeModel({ id: "openai/gpt-4o" });
		const index = buildModelReferenceIndex([model]);
		expect(index.suffixAlias.has("gpt-4o")).toBe(true);
	});
	it("does not build suffix alias for non-slashed ids", () => {
		const model = makeModel({ id: "gpt-4o" });
		const index = buildModelReferenceIndex([model]);
		expect(index.suffixAlias.size).toBe(0);
	});
	it("replaces with higher context window", () => {
		const low = makeModel({ id: "gpt-4o", contextWindow: 4096 });
		const high = makeModel({ id: "gpt-4o", contextWindow: 128000 });
		const index = buildModelReferenceIndex([low, high]);
		expect(index.exact.get("gpt-4o")?.contextWindow).toBe(128000);
	});
	it("prefers openai provider over others on tie", () => {
		const other = makeModel({ id: "gpt-4o", provider: "other" });
		const openai = makeModel({ id: "gpt-4o", provider: "openai" });
		const index = buildModelReferenceIndex([other, openai]);
		expect(index.exact.get("gpt-4o")?.provider).toBe("openai");
	});
});

describe("resolveModelReference", () => {
	it("resolves exact match", () => {
		const model = makeModel({ id: "gpt-4o" });
		const index = buildModelReferenceIndex([model]);
		expect(resolveModelReference("gpt-4o", index)?.id).toBe("gpt-4o");
	});
	it("resolves case-insensitively", () => {
		const model = makeModel({ id: "gpt-4o" });
		const index = buildModelReferenceIndex([model]);
		expect(resolveModelReference("GPT-4O", index)?.id).toBe("gpt-4o");
	});
	it("resolves via suffix alias", () => {
		const model = makeModel({ id: "openai/gpt-4o" });
		const index = buildModelReferenceIndex([model]);
		expect(resolveModelReference("gpt-4o", index)?.id).toBe("openai/gpt-4o");
	});
	it("resolves via bracket stripping", () => {
		const model = makeModel({ id: "gpt-4o" });
		const index = buildModelReferenceIndex([model]);
		expect(resolveModelReference("[Author] gpt-4o", index)?.id).toBe("gpt-4o");
	});
	it("resolves via colon-to-dash", () => {
		const model = makeModel({ id: "gpt-4o" });
		const index = buildModelReferenceIndex([model]);
		expect(resolveModelReference("gpt:4o", index)?.id).toBe("gpt-4o");
	});
	it("resolves via trailing marker stripping", () => {
		const model = makeModel({ id: "gpt-4o" });
		const index = buildModelReferenceIndex([model]);
		expect(resolveModelReference("gpt-4o-thinking", index)?.id).toBe("gpt-4o");
	});
	it("resolves via cloud suffix stripping", () => {
		const model = makeModel({ id: "gpt-4o" });
		const index = buildModelReferenceIndex([model]);
		expect(resolveModelReference("gpt-4o:cloud", index)?.id).toBe("gpt-4o");
	});
	it("returns undefined for no match", () => {
		const model = makeModel({ id: "gpt-4o" });
		const index = buildModelReferenceIndex([model]);
		expect(resolveModelReference("unknown-model", index)).toBeUndefined();
	});
	it("resolves via slash suffix", () => {
		const model = makeModel({ id: "openai/gpt-4o" });
		const index = buildModelReferenceIndex([model]);
		expect(resolveModelReference("openai/gpt-4o", index)?.id).toBe("openai/gpt-4o");
	});
});
