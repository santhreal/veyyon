import { describe, expect, it } from "bun:test";
import { DIALECTS, FALLBACK_DIALECT, preferredDialect } from "../src/identity/dialect";
import {
	isClaudeModelId,
	isDeepseekModelIdOrName,
	isGemmaModelId,
	isKimiModelId,
	isOpenAIGptOssModelId,
	isOpenAIModelId,
	isQwenModelId,
	modelFamilyToken,
} from "../src/identity/family";
import {
	getBracketStrippedModelIdCandidates,
	getLongestModelLikeIdSegment,
	getModelLikeIdSegments,
	stripBracketedModelIdAffixes,
} from "../src/identity/id";
import { REFERENCE_TRAILING_MARKER_PATTERN } from "../src/identity/markers";
import { buildModelProviderPriorityRank } from "../src/identity/priority";

describe("DIALECTS", () => {
	it("contains 12 dialects", () => {
		expect(DIALECTS).toHaveLength(12);
	});
	it("contains anthropic", () => {
		expect(DIALECTS).toContain("anthropic");
	});
	it("contains gemini", () => {
		expect(DIALECTS).toContain("gemini");
	});
	it("contains deepseek", () => {
		expect(DIALECTS).toContain("deepseek");
	});
});

describe("FALLBACK_DIALECT", () => {
	it("is xml", () => {
		expect(FALLBACK_DIALECT).toBe("xml");
	});
});

describe("preferredDialect", () => {
	it("returns anthropic for claude model", () => {
		expect(preferredDialect("claude-3-opus")).toBe("anthropic");
	});
	it("returns gemini for gemini model", () => {
		expect(preferredDialect("gemini-1.5-pro")).toBe("gemini");
	});
	it("returns deepseek for deepseek model", () => {
		expect(preferredDialect("deepseek-chat")).toBe("deepseek");
	});
	it("returns harmony for openai model", () => {
		expect(preferredDialect("gpt-4o")).toBe("harmony");
	});
	it("returns harmony for gpt-oss model", () => {
		expect(preferredDialect("gpt-oss-120b")).toBe("harmony");
	});
	it("returns qwen3 for qwen model", () => {
		expect(preferredDialect("qwen-2.5-coder")).toBe("qwen3");
	});
	it("returns kimi for kimi model", () => {
		expect(preferredDialect("kimi-k2")).toBe("kimi");
	});
	it("returns gemma for gemma model", () => {
		expect(preferredDialect("gemma-2-9b")).toBe("gemma");
	});
	it("returns minimax for minimax model", () => {
		expect(preferredDialect("minimax-m2")).toBe("minimax");
	});
	it("returns fallback for unknown model", () => {
		expect(preferredDialect("unknown-model")).toBe(FALLBACK_DIALECT);
	});
});

describe("REFERENCE_TRAILING_MARKER_PATTERN", () => {
	it("matches -thinking suffix", () => {
		expect(REFERENCE_TRAILING_MARKER_PATTERN.test("model-thinking")).toBe(true);
	});
	it("matches -high suffix", () => {
		expect(REFERENCE_TRAILING_MARKER_PATTERN.test("model-high")).toBe(true);
	});
	it("matches -low suffix", () => {
		expect(REFERENCE_TRAILING_MARKER_PATTERN.test("model-low")).toBe(true);
	});
	it("matches -search suffix", () => {
		expect(REFERENCE_TRAILING_MARKER_PATTERN.test("model-search")).toBe(true);
	});
	it("matches :thinking suffix", () => {
		expect(REFERENCE_TRAILING_MARKER_PATTERN.test("model:thinking")).toBe(true);
	});
	it("is case-insensitive", () => {
		expect(REFERENCE_TRAILING_MARKER_PATTERN.test("model-THINKING")).toBe(true);
	});
	it("does not match without suffix", () => {
		expect(REFERENCE_TRAILING_MARKER_PATTERN.test("model")).toBe(false);
	});
	it("matches -fp8 suffix", () => {
		expect(REFERENCE_TRAILING_MARKER_PATTERN.test("model-fp8")).toBe(true);
	});
	it("matches -bf16 suffix", () => {
		expect(REFERENCE_TRAILING_MARKER_PATTERN.test("model-bf16")).toBe(true);
	});
	it("matches -nitro suffix", () => {
		expect(REFERENCE_TRAILING_MARKER_PATTERN.test("model-nitro")).toBe(true);
	});
	it("does not match -fast suffix", () => {
		expect(REFERENCE_TRAILING_MARKER_PATTERN.test("model-fast")).toBe(false);
	});
});

describe("buildModelProviderPriorityRank", () => {
	it("returns Map with default providers", () => {
		const rank = buildModelProviderPriorityRank();
		expect(rank.size).toBeGreaterThan(0);
	});
	it("ranks openai-codex first by default", () => {
		const rank = buildModelProviderPriorityRank();
		expect(rank.get("openai-codex")).toBe(0);
	});
	it("ranks anthropic second by default", () => {
		const rank = buildModelProviderPriorityRank();
		expect(rank.get("anthropic")).toBe(1);
	});
	it("prioritizes configured providers over defaults", () => {
		const rank = buildModelProviderPriorityRank(["my-provider", "openai"]);
		expect(rank.get("my-provider")).toBe(0);
		expect(rank.get("openai")).toBe(1);
		expect(rank.get("openai-codex")).toBe(2);
	});
	it("does not duplicate providers already in rank", () => {
		const rank = buildModelProviderPriorityRank(["anthropic"]);
		expect(rank.get("anthropic")).toBe(0);
		expect(rank.get("openai-codex")).toBe(1);
	});
	it("normalizes provider names to lowercase", () => {
		const rank = buildModelProviderPriorityRank(["MyProvider"]);
		expect(rank.has("myprovider")).toBe(true);
	});
	it("skips empty/whitespace providers", () => {
		const rank = buildModelProviderPriorityRank(["", "  ", "openai"]);
		expect(rank.get("openai")).toBe(0);
	});
});

describe("getModelLikeIdSegments", () => {
	it("extracts model-like segments", () => {
		const segments = getModelLikeIdSegments("claude-3-opus");
		expect(segments).toContain("claude-3-opus");
	});
	it("returns empty for non-model string", () => {
		expect(getModelLikeIdSegments("hello world")).toEqual([]);
	});
	it("extracts multiple segments", () => {
		const segments = getModelLikeIdSegments("gpt-4o and claude-3-opus");
		expect(segments.length).toBeGreaterThan(0);
	});
	it("deduplicates segments", () => {
		const segments = getModelLikeIdSegments("gpt-4o gpt-4o");
		const unique = new Set(segments);
		expect(unique.size).toBe(segments.length);
	});
});

describe("getLongestModelLikeIdSegment", () => {
	it("returns longest segment", () => {
		const result = getLongestModelLikeIdSegment("claude-3-opus");
		expect(result).toBeDefined();
		expect(result!.length).toBeGreaterThan(0);
	});
	it("returns undefined for non-model string", () => {
		expect(getLongestModelLikeIdSegment("hello world")).toBeUndefined();
	});
});

describe("getBracketStrippedModelIdCandidates", () => {
	it("returns empty for string without brackets", () => {
		expect(getBracketStrippedModelIdCandidates("claude-3-opus")).toEqual([]);
	});
	it("strips leading bracket", () => {
		const result = getBracketStrippedModelIdCandidates("[Author] claude-3-opus");
		expect(result).toContain("claude-3-opus");
	});
	it("strips trailing bracket", () => {
		const result = getBracketStrippedModelIdCandidates("claude-3-opus [latest]");
		expect(result).toContain("claude-3-opus");
	});
	it("strips both brackets", () => {
		const result = getBracketStrippedModelIdCandidates("[Author] claude-3-opus [latest]");
		expect(result).toContain("claude-3-opus");
	});
	it("handles CJK brackets", () => {
		const result = getBracketStrippedModelIdCandidates("【作者】claude-3-opus");
		expect(result).toContain("claude-3-opus");
	});
});

describe("stripBracketedModelIdAffixes", () => {
	it("returns first candidate", () => {
		const result = stripBracketedModelIdAffixes("[Author] claude-3-opus");
		expect(result).toBe("claude-3-opus");
	});
	it("returns undefined for no brackets", () => {
		expect(stripBracketedModelIdAffixes("claude-3-opus")).toBeUndefined();
	});
});

describe("family predicates", () => {
	it("isClaudeModelId matches claude", () => {
		expect(isClaudeModelId("claude-3-opus")).toBe(true);
	});
	it("isClaudeModelId matches with slash", () => {
		expect(isClaudeModelId("anthropic/claude-3-opus")).toBe(true);
	});
	it("isClaudeModelId does not match non-claude", () => {
		expect(isClaudeModelId("gpt-4o")).toBe(false);
	});
	it("isKimiModelId matches kimi", () => {
		expect(isKimiModelId("kimi-k2")).toBe(true);
	});
	it("isKimiModelId matches moonshotai/kimi", () => {
		expect(isKimiModelId("moonshotai/kimi-k2")).toBe(true);
	});
	it("isQwenModelId matches qwen", () => {
		expect(isQwenModelId("qwen-2.5-coder")).toBe(true);
	});
	it("isQwenModelId is case-insensitive", () => {
		expect(isQwenModelId("QWEN-2.5")).toBe(true);
	});
	it("isGemmaModelId matches gemma", () => {
		expect(isGemmaModelId("gemma-2-9b")).toBe(true);
	});
	it("isDeepseekModelIdOrName matches deepseek", () => {
		expect(isDeepseekModelIdOrName("deepseek-chat")).toBe(true);
	});
	it("isDeepseekModelIdOrName is case-insensitive", () => {
		expect(isDeepseekModelIdOrName("DeepSeek-Chat")).toBe(true);
	});
	it("isOpenAIGptOssModelId matches gpt-oss", () => {
		expect(isOpenAIGptOssModelId("gpt-oss-120b")).toBe(true);
	});
	it("isOpenAIModelId matches gpt", () => {
		expect(isOpenAIModelId("gpt-4o")).toBe(true);
	});
	it("modelFamilyToken returns openai for gpt", () => {
		expect(modelFamilyToken("gpt-4o")).toBe("openai");
	});
	it("modelFamilyToken returns anthropic for claude", () => {
		expect(modelFamilyToken("claude-3-opus")).toBe("anthropic");
	});
});
