import { describe, expect, it } from "bun:test";
import {
	getBracketStrippedModelIdCandidates,
	getLongestModelLikeIdSegment,
	getModelLikeIdSegments,
	stripBracketedModelIdAffixes,
} from "../src/identity/id";
import {
	buildModelReferenceIndex,
	isZeroCostXaiOAuthReference,
	type ModelReferenceIndex,
	resolveModelReference,
} from "../src/identity/reference";
import type { Api, Model } from "../src/types";

function makeModel(id: string, provider: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		provider,
		label: id,
		api: "openai" as Api,
		contextWindow: 128000,
		maxTokens: 16384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...overrides,
	} as unknown as Model<Api>;
}

describe("getModelLikeIdSegments", () => {
	it("extracts model-like segments", () => {
		const segments = getModelLikeIdSegments("openai/gpt-4o-mini");
		expect(segments).toContain("gpt-4o-mini");
	});
	it("returns empty for no model-like segments", () => {
		expect(getModelLikeIdSegments("hello world")).toEqual([]);
	});
	it("extracts multiple segments", () => {
		const segments = getModelLikeIdSegments("claude-opus-4.7 and gpt-4");
		expect(segments).toContain("claude-opus-4.7");
		expect(segments).toContain("gpt-4");
	});
	it("sorts by length descending", () => {
		const segments = getModelLikeIdSegments("gpt-4 claude-opus-4.7");
		expect(segments[0]).toBe("claude-opus-4.7");
	});
	it("deduplicates segments", () => {
		const segments = getModelLikeIdSegments("gpt-4 gpt-4");
		expect(segments).toEqual(["gpt-4"]);
	});
	it("requires digit in segment", () => {
		expect(getModelLikeIdSegments("claude")).toEqual([]);
	});
	it("normalizes whitespace", () => {
		const segments = getModelLikeIdSegments("  gpt-4  ");
		expect(segments).toEqual(["gpt-4"]);
	});
	it("is case insensitive", () => {
		const segments = getModelLikeIdSegments("GPT-4");
		expect(segments).toContain("gpt-4");
	});
});

describe("getLongestModelLikeIdSegment", () => {
	it("returns longest segment", () => {
		expect(getLongestModelLikeIdSegment("gpt-4 claude-opus-4.7")).toBe("claude-opus-4.7");
	});
	it("returns undefined for no segments", () => {
		expect(getLongestModelLikeIdSegment("hello world")).toBeUndefined();
	});
	it("returns single segment", () => {
		expect(getLongestModelLikeIdSegment("gpt-4")).toBe("gpt-4");
	});
});

describe("getBracketStrippedModelIdCandidates", () => {
	it("returns empty for no brackets", () => {
		expect(getBracketStrippedModelIdCandidates("gpt-4")).toEqual([]);
	});
	it("strips leading bracket", () => {
		expect(getBracketStrippedModelIdCandidates("[preview] gpt-4")).toContain("gpt-4");
	});
	it("strips trailing bracket", () => {
		expect(getBracketStrippedModelIdCandidates("gpt-4 [preview]")).toContain("gpt-4");
	});
	it("strips both brackets", () => {
		const candidates = getBracketStrippedModelIdCandidates("[a] gpt-4 [b]");
		expect(candidates).toContain("gpt-4");
	});
	it("handles unicode brackets", () => {
		expect(getBracketStrippedModelIdCandidates("【preview】 gpt-4")).toContain("gpt-4");
	});
	it("returns empty for empty string", () => {
		expect(getBracketStrippedModelIdCandidates("")).toEqual([]);
	});
	it("does not include original in candidates", () => {
		const candidates = getBracketStrippedModelIdCandidates("[a] gpt-4");
		expect(candidates).not.toContain("[a] gpt-4");
	});
});

describe("stripBracketedModelIdAffixes", () => {
	it("returns first candidate", () => {
		expect(stripBracketedModelIdAffixes("[preview] gpt-4")).toBe("gpt-4");
	});
	it("returns undefined for no brackets", () => {
		expect(stripBracketedModelIdAffixes("gpt-4")).toBeUndefined();
	});
});

describe("isZeroCostXaiOAuthReference", () => {
	it("returns true for zero-cost xai-oauth model", () => {
		expect(isZeroCostXaiOAuthReference(makeModel("grok-3", "xai-oauth"))).toBe(true);
	});
	it("returns false for non-zero-cost xai-oauth model", () => {
		expect(
			isZeroCostXaiOAuthReference(
				makeModel("grok-3", "xai-oauth", { cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }),
			),
		).toBe(false);
	});
	it("returns false for zero-cost non-xai-oauth model", () => {
		expect(isZeroCostXaiOAuthReference(makeModel("gpt-4", "openai"))).toBe(false);
	});
	it("returns false for xai-oauth with cache pricing", () => {
		expect(
			isZeroCostXaiOAuthReference(
				makeModel("grok-3", "xai-oauth", { cost: { input: 0, output: 0, cacheRead: 1, cacheWrite: 0 } }),
			),
		).toBe(false);
	});
});

describe("buildModelReferenceIndex", () => {
	it("builds exact map from models", () => {
		const models = [makeModel("gpt-4", "openai"), makeModel("claude-opus-4.7", "anthropic")];
		const index = buildModelReferenceIndex(models);
		expect(index.exact.get("gpt-4")).toBeDefined();
		expect(index.exact.get("claude-opus-4.7")).toBeDefined();
	});
	it("skips zero-cost xai-oauth references", () => {
		const models = [makeModel("grok-3", "xai-oauth")];
		const index = buildModelReferenceIndex(models);
		expect(index.exact.get("grok-3")).toBeUndefined();
	});
	it("builds suffix alias map", () => {
		const models = [makeModel("openai/gpt-4", "openai")];
		const index = buildModelReferenceIndex(models);
		expect(index.suffixAlias.get("gpt-4")).toBeDefined();
	});
	it("replaces reference with larger context window", () => {
		const small = makeModel("gpt-4", "openai", { contextWindow: 8000 });
		const large = makeModel("gpt-4", "openai", { contextWindow: 128000 });
		const index = buildModelReferenceIndex([small, large]);
		expect(index.exact.get("gpt-4")?.contextWindow).toBe(128000);
	});
});

describe("resolveModelReference", () => {
	it("resolves by exact key", () => {
		const models = [makeModel("gpt-4", "openai")];
		const index = buildModelReferenceIndex(models);
		expect(resolveModelReference("gpt-4", index)?.id).toBe("gpt-4");
	});
	it("resolves by suffix alias", () => {
		const models = [makeModel("openai/gpt-4", "openai")];
		const index = buildModelReferenceIndex(models);
		expect(resolveModelReference("gpt-4", index)?.id).toBe("openai/gpt-4");
	});
	it("resolves case-insensitively", () => {
		const models = [makeModel("gpt-4", "openai")];
		const index = buildModelReferenceIndex(models);
		expect(resolveModelReference("GPT-4", index)?.id).toBe("gpt-4");
	});
	it("resolves by stripping provider prefix", () => {
		const models = [makeModel("gpt-4", "openai")];
		const index = buildModelReferenceIndex(models);
		expect(resolveModelReference("openai/gpt-4", index)?.id).toBe("gpt-4");
	});
	it("resolves by stripping trailing marker", () => {
		const models = [makeModel("gpt-4", "openai")];
		const index = buildModelReferenceIndex(models);
		expect(resolveModelReference("gpt-4-thinking", index)?.id).toBe("gpt-4");
	});
	it("resolves by stripping :cloud suffix", () => {
		const models = [makeModel("gpt-4", "openai")];
		const index = buildModelReferenceIndex(models);
		expect(resolveModelReference("gpt-4:cloud", index)?.id).toBe("gpt-4");
	});
	it("resolves by stripping -cloud suffix", () => {
		const models = [makeModel("gpt-4", "openai")];
		const index = buildModelReferenceIndex(models);
		expect(resolveModelReference("gpt-4-cloud", index)?.id).toBe("gpt-4");
	});
	it("resolves by replacing colons with dashes", () => {
		const models = [makeModel("gpt-4", "openai")];
		const index = buildModelReferenceIndex(models);
		expect(resolveModelReference("gpt:4", index)?.id).toBe("gpt-4");
	});
	it("returns undefined for no match", () => {
		const index: ModelReferenceIndex = { exact: new Map(), suffixAlias: new Map() };
		expect(resolveModelReference("nonexistent", index)).toBeUndefined();
	});
	it("resolves by stripping bracket affixes", () => {
		const models = [makeModel("gpt-4", "openai")];
		const index = buildModelReferenceIndex(models);
		expect(resolveModelReference("[preview] gpt-4", index)?.id).toBe("gpt-4");
	});
});
