import { describe, expect, it } from "bun:test";
import {
	findThinkingVariantToken,
	hasOpus47ApiRestrictions,
	isAnthropicFableOrMythosModel,
	isAnthropicNamespacedModelId,
	isClaudeModelId,
	isDeepseekModelIdOrName,
	isGemmaModelId,
	isGlm52ReasoningEffortModelId,
	isGlmVisionModelId,
	isGrokReasoningEffortCapable,
	isKimiK26ModelId,
	isKimiModelId,
	isMimoModelIdOrName,
	isMinimaxM2FamilyModelId,
	isMinimaxM3FamilyModelId,
	isOpenAIGptOssModelId,
	isOpenAIModelId,
	isOpenAIOSeriesModelId,
	isQwenModelId,
	isReasoningGlmModelId,
	modelFamilyToken,
	statesOpenAIWireGeneration,
	stripThinkingVariantToken,
	supportsAdaptiveThinkingDisplay,
	supportsAllTurnsReasoningContext,
	supportsCodexReasoningSummary,
	supportsMidConversationSystemMessages,
	supportsOpenAIPromptCacheBreakpoints,
} from "../src/identity/family";

describe("isKimiModelId", () => {
	it("matches moonshotai/kimi prefix", () => {
		expect(isKimiModelId("moonshotai/kimi-k2")).toBe(true);
	});
	it("matches kimi- prefix", () => {
		expect(isKimiModelId("kimi-k2-0905")).toBe(true);
	});
	it("matches /kimi- prefix", () => {
		expect(isKimiModelId("provider/kimi-k2")).toBe(true);
	});
	it("does not match unrelated id", () => {
		expect(isKimiModelId("gpt-4")).toBe(false);
	});
	it("matches kimi. prefix", () => {
		expect(isKimiModelId("kimi.k2")).toBe(true);
	});
});

describe("isKimiK26ModelId", () => {
	it("matches kimi-k2.6", () => {
		expect(isKimiK26ModelId("kimi-k2.6")).toBe(true);
	});
	it("matches kimi-k2p6", () => {
		expect(isKimiK26ModelId("kimi-k2p6")).toBe(true);
	});
	it("matches kimi-k2.6 with suffix", () => {
		expect(isKimiK26ModelId("kimi-k2.6-preview")).toBe(true);
	});
	it("does not match kimi-k2", () => {
		expect(isKimiK26ModelId("kimi-k2")).toBe(false);
	});
	it("does not match unrelated", () => {
		expect(isKimiK26ModelId("gpt-4")).toBe(false);
	});
});

describe("isClaudeModelId", () => {
	it("matches claude- prefix", () => {
		expect(isClaudeModelId("claude-opus-4.7")).toBe(true);
	});
	it("matches /claude- prefix", () => {
		expect(isClaudeModelId("anthropic/claude-opus-4.7")).toBe(true);
	});
	it("matches claude. prefix", () => {
		expect(isClaudeModelId("claude.3.5-sonnet")).toBe(true);
	});
	it("does not match unrelated", () => {
		expect(isClaudeModelId("gpt-4")).toBe(false);
	});
});

describe("isAnthropicNamespacedModelId", () => {
	it("matches anthropic/ namespace", () => {
		expect(isAnthropicNamespacedModelId("anthropic/claude-opus-4.7")).toBe(true);
	});
	it("matches /anthropic/ namespace", () => {
		expect(isAnthropicNamespacedModelId("provider/anthropic/claude")).toBe(true);
	});
	it("does not match without namespace", () => {
		expect(isAnthropicNamespacedModelId("claude-opus-4.7")).toBe(false);
	});
});

describe("isQwenModelId", () => {
	it("matches qwen case-insensitively", () => {
		expect(isQwenModelId("qwen-2.5")).toBe(true);
	});
	it("matches QWEN uppercase", () => {
		expect(isQwenModelId("QWEN-2.5")).toBe(true);
	});
	it("does not match unrelated", () => {
		expect(isQwenModelId("gpt-4")).toBe(false);
	});
});

describe("isGemmaModelId", () => {
	it("matches gemma- with digit", () => {
		expect(isGemmaModelId("gemma-2")).toBe(true);
	});
	it("matches /gemma- with digit", () => {
		expect(isGemmaModelId("google/gemma-2")).toBe(true);
	});
	it("matches gemma. with digit", () => {
		expect(isGemmaModelId("gemma.2")).toBe(true);
	});
	it("matches gemma2 without separator", () => {
		expect(isGemmaModelId("gemma2")).toBe(true);
	});
	it("does not match gemma without digit", () => {
		expect(isGemmaModelId("gemma")).toBe(false);
	});
	it("does not match unrelated", () => {
		expect(isGemmaModelId("gpt-4")).toBe(false);
	});
});

describe("isDeepseekModelIdOrName", () => {
	it("matches deepseek case-insensitively", () => {
		expect(isDeepseekModelIdOrName("deepseek-r1")).toBe(true);
	});
	it("matches DEEPSEEK uppercase", () => {
		expect(isDeepseekModelIdOrName("DEEPSEEK-V3")).toBe(true);
	});
	it("does not match unrelated", () => {
		expect(isDeepseekModelIdOrName("gpt-4")).toBe(false);
	});
});

describe("isMimoModelIdOrName", () => {
	it("matches mimo case-insensitively", () => {
		expect(isMimoModelIdOrName("mimo-7b")).toBe(true);
	});
	it("matches MIMO uppercase", () => {
		expect(isMimoModelIdOrName("MIMO-7B")).toBe(true);
	});
	it("does not match unrelated", () => {
		expect(isMimoModelIdOrName("gpt-4")).toBe(false);
	});
});

describe("isOpenAIOSeriesModelId", () => {
	it("matches o1", () => {
		expect(isOpenAIOSeriesModelId("o1")).toBe(true);
	});
	it("matches o1- prefix", () => {
		expect(isOpenAIOSeriesModelId("o1-mini")).toBe(true);
	});
	it("matches o3", () => {
		expect(isOpenAIOSeriesModelId("o3")).toBe(true);
	});
	it("matches o4", () => {
		expect(isOpenAIOSeriesModelId("o4-mini")).toBe(true);
	});
	it("does not match o2", () => {
		expect(isOpenAIOSeriesModelId("o2")).toBe(false);
	});
	it("does not match o5", () => {
		expect(isOpenAIOSeriesModelId("o5")).toBe(false);
	});
	it("does not match unrelated", () => {
		expect(isOpenAIOSeriesModelId("gpt-4")).toBe(false);
	});
	it("strips provider prefix", () => {
		expect(isOpenAIOSeriesModelId("openai/o1-mini")).toBe(true);
	});
});

describe("isGrokReasoningEffortCapable", () => {
	it("matches grok-3-mini", () => {
		expect(isGrokReasoningEffortCapable("grok-3-mini")).toBe(true);
	});
	it("matches grok-4.20-multi-agent", () => {
		expect(isGrokReasoningEffortCapable("grok-4.20-multi-agent")).toBe(true);
	});
	it("matches grok-4.3", () => {
		expect(isGrokReasoningEffortCapable("grok-4.3")).toBe(true);
	});
	it("matches grok-4.5", () => {
		expect(isGrokReasoningEffortCapable("grok-4.5")).toBe(true);
	});
	it("matches grok-4.6", () => {
		expect(isGrokReasoningEffortCapable("grok-4.6")).toBe(true);
	});
	it("matches grok-build", () => {
		expect(isGrokReasoningEffortCapable("grok-build")).toBe(true);
	});
	it("does not match grok-2", () => {
		expect(isGrokReasoningEffortCapable("grok-2")).toBe(false);
	});
	it("does not match unrelated", () => {
		expect(isGrokReasoningEffortCapable("gpt-4")).toBe(false);
	});
	it("does not match empty", () => {
		expect(isGrokReasoningEffortCapable("")).toBe(false);
	});
});

describe("isMinimaxM2FamilyModelId", () => {
	it("matches minimax m2", () => {
		expect(isMinimaxM2FamilyModelId("minimax-m2")).toBe(true);
	});
	it("matches minimax m20", () => {
		expect(isMinimaxM2FamilyModelId("minimax-m20")).toBe(true);
	});
	it("matches minimax/m2", () => {
		expect(isMinimaxM2FamilyModelId("minimax/m2")).toBe(true);
	});
	it("matches minimax.m2", () => {
		expect(isMinimaxM2FamilyModelId("minimax.m2")).toBe(true);
	});
	it("matches m2 with version suffix", () => {
		expect(isMinimaxM2FamilyModelId("minimax-m2-1.0")).toBe(true);
	});
	it("does not match without minimax", () => {
		expect(isMinimaxM2FamilyModelId("m2")).toBe(false);
	});
	it("does not match unrelated", () => {
		expect(isMinimaxM2FamilyModelId("gpt-4")).toBe(false);
	});
});

describe("isMinimaxM3FamilyModelId", () => {
	it("matches minimax m3", () => {
		expect(isMinimaxM3FamilyModelId("minimax-m3")).toBe(true);
	});
	it("matches minimax/m3", () => {
		expect(isMinimaxM3FamilyModelId("minimax/m3")).toBe(true);
	});
	it("matches m3 alone with minimax", () => {
		expect(isMinimaxM3FamilyModelId("minimax/m3-1.0")).toBe(true);
	});
	it("does not match without minimax", () => {
		expect(isMinimaxM3FamilyModelId("m3")).toBe(false);
	});
	it("does not match unrelated", () => {
		expect(isMinimaxM3FamilyModelId("gpt-4")).toBe(false);
	});
});

describe("isOpenAIGptOssModelId", () => {
	it("matches gpt-oss- prefix", () => {
		expect(isOpenAIGptOssModelId("gpt-oss-120b")).toBe(true);
	});
	it("matches /gpt-oss- prefix", () => {
		expect(isOpenAIGptOssModelId("openai/gpt-oss-120b")).toBe(true);
	});
	it("matches gpt-oss: prefix", () => {
		expect(isOpenAIGptOssModelId("gpt-oss:120b")).toBe(true);
	});
	it("does not match gpt-4", () => {
		expect(isOpenAIGptOssModelId("gpt-4")).toBe(false);
	});
});

describe("isOpenAIModelId", () => {
	it("matches gpt- prefix", () => {
		expect(isOpenAIModelId("gpt-4")).toBe(true);
	});
	it("matches chatgpt- prefix", () => {
		expect(isOpenAIModelId("chatgpt-4o-latest")).toBe(true);
	});
	it("matches codex- prefix", () => {
		expect(isOpenAIModelId("codex-mini-latest")).toBe(true);
	});
	it("matches o1 series", () => {
		expect(isOpenAIModelId("o1-mini")).toBe(true);
	});
	it("matches openai/ namespace", () => {
		expect(isOpenAIModelId("openai/some-model")).toBe(true);
	});
	it("does not match unrelated", () => {
		expect(isOpenAIModelId("claude-opus-4")).toBe(false);
	});
});

describe("supportsOpenAIPromptCacheBreakpoints", () => {
	it("returns true for gpt-5.6+", () => {
		expect(supportsOpenAIPromptCacheBreakpoints("gpt-5.6")).toBe(true);
	});
	it("returns false for gpt-5.5", () => {
		expect(supportsOpenAIPromptCacheBreakpoints("gpt-5.5")).toBe(false);
	});
	it("returns false for gpt-4", () => {
		expect(supportsOpenAIPromptCacheBreakpoints("gpt-4")).toBe(false);
	});
});

describe("supportsAllTurnsReasoningContext", () => {
	it("returns true for gpt-5.4+", () => {
		expect(supportsAllTurnsReasoningContext("gpt-5.4")).toBe(true);
	});
	it("returns false for gpt-5.3", () => {
		expect(supportsAllTurnsReasoningContext("gpt-5.3")).toBe(false);
	});
});

describe("statesOpenAIWireGeneration", () => {
	it("returns true for gpt model", () => {
		expect(statesOpenAIWireGeneration("gpt-4")).toBe(true);
	});
	it("returns false for non-gpt model", () => {
		expect(statesOpenAIWireGeneration("claude-opus-4")).toBe(false);
	});
});

describe("supportsCodexReasoningSummary", () => {
	it("returns true for gpt-5.4+", () => {
		expect(supportsCodexReasoningSummary("gpt-5.4")).toBe(true);
	});
	it("returns false for gpt-5.3", () => {
		expect(supportsCodexReasoningSummary("gpt-5.3")).toBe(false);
	});
});

describe("isReasoningGlmModelId", () => {
	it("returns true for glm-4.5 base", () => {
		expect(isReasoningGlmModelId("glm-4.5")).toBe(true);
	});
	it("returns true for glm-4.5 air", () => {
		expect(isReasoningGlmModelId("glm-4.5-air")).toBe(true);
	});
	it("returns true for glm-4.5 turbo", () => {
		expect(isReasoningGlmModelId("glm-4.5-turbo")).toBe(true);
	});
	it("returns false for glm-4.5 flash (wrong variant)", () => {
		expect(isReasoningGlmModelId("glm-4.5-flash")).toBe(false);
	});
	it("returns false for glm-4.5v (vision)", () => {
		expect(isReasoningGlmModelId("glm-4.5v")).toBe(false);
	});
	it("returns false for glm-4.4 (below 4.5)", () => {
		expect(isReasoningGlmModelId("glm-4.4")).toBe(false);
	});
	it("returns false for non-glm", () => {
		expect(isReasoningGlmModelId("gpt-4")).toBe(false);
	});
});

describe("isGlm52ReasoningEffortModelId", () => {
	it("returns true for glm-5.2 base", () => {
		expect(isGlm52ReasoningEffortModelId("glm-5.2")).toBe(true);
	});
	it("returns true for glm-5.2 air", () => {
		expect(isGlm52ReasoningEffortModelId("glm-5.2-air")).toBe(true);
	});
	it("returns false for glm-5.1 (below 5.2)", () => {
		expect(isGlm52ReasoningEffortModelId("glm-5.1")).toBe(false);
	});
	it("returns false for glm-5.2 flash (wrong variant)", () => {
		expect(isGlm52ReasoningEffortModelId("glm-5.2-flash")).toBe(false);
	});
	it("returns false for glm-5.2v (vision)", () => {
		expect(isGlm52ReasoningEffortModelId("glm-5.2v")).toBe(false);
	});
	it("returns false for non-glm", () => {
		expect(isGlm52ReasoningEffortModelId("gpt-4")).toBe(false);
	});
});

describe("isGlmVisionModelId", () => {
	it("returns true for glm-4.5v", () => {
		expect(isGlmVisionModelId("glm-4.5v")).toBe(true);
	});
	it("returns false for glm-4.5 (no v)", () => {
		expect(isGlmVisionModelId("glm-4.5")).toBe(false);
	});
	it("returns false for non-glm", () => {
		expect(isGlmVisionModelId("gpt-4")).toBe(false);
	});
});

describe("modelFamilyToken", () => {
	it("returns gemini for gemini model", () => {
		expect(modelFamilyToken("gemini-1.5-pro")).toBe("gemini");
	});
	it("returns anthropic for claude model", () => {
		expect(modelFamilyToken("claude-opus-4.7")).toBe("anthropic");
	});
	it("returns openai for gpt model", () => {
		expect(modelFamilyToken("gpt-4")).toBe("openai");
	});
	it("returns kimi for kimi model", () => {
		expect(modelFamilyToken("kimi-k2")).toBe("kimi");
	});
	it("returns qwen for qwen model", () => {
		expect(modelFamilyToken("qwen-2.5")).toBe("qwen");
	});
	it("returns minimax for minimax m2 model", () => {
		expect(modelFamilyToken("minimax-m2")).toBe("minimax");
	});
	it("returns deepseek for deepseek model", () => {
		expect(modelFamilyToken("deepseek-r1")).toBe("deepseek");
	});
	it("returns mimo for mimo model", () => {
		expect(modelFamilyToken("mimo-7b")).toBe("mimo");
	});
	it("returns gemma for gemma model", () => {
		expect(modelFamilyToken("gemma-2")).toBe("gemma");
	});
	it("returns glm for glm model", () => {
		expect(modelFamilyToken("glm-4.5")).toBe("glm");
	});
	it("returns openai for gpt-oss model (matched by openai first)", () => {
		expect(modelFamilyToken("gpt-oss-120b")).toBe("openai");
	});
	it("returns empty for unknown", () => {
		expect(modelFamilyToken("unknown-model")).toBe("");
	});
	it("returns anthropic for anthropic/ namespace", () => {
		expect(modelFamilyToken("anthropic/unknown-model")).toBe("anthropic");
	});
});

describe("supportsAdaptiveThinkingDisplay", () => {
	it("returns true for claude-opus-4.7", () => {
		expect(supportsAdaptiveThinkingDisplay("claude-opus-4.7")).toBe(true);
	});
	it("returns false for claude-opus-4.5", () => {
		expect(supportsAdaptiveThinkingDisplay("claude-opus-4.5")).toBe(false);
	});
	it("returns false for non-anthropic", () => {
		expect(supportsAdaptiveThinkingDisplay("gpt-4")).toBe(false);
	});
});

describe("hasOpus47ApiRestrictions", () => {
	it("returns true for claude-opus-4.7", () => {
		expect(hasOpus47ApiRestrictions("claude-opus-4.7")).toBe(true);
	});
	it("returns false for claude-opus-4.5", () => {
		expect(hasOpus47ApiRestrictions("claude-opus-4.5")).toBe(false);
	});
});

describe("supportsMidConversationSystemMessages", () => {
	it("returns true for claude-opus-4.8", () => {
		expect(supportsMidConversationSystemMessages("claude-opus-4.8")).toBe(true);
	});
	it("returns false for claude-opus-4.7", () => {
		expect(supportsMidConversationSystemMessages("claude-opus-4.7")).toBe(false);
	});
	it("returns true for claude-sonnet-5.0", () => {
		expect(supportsMidConversationSystemMessages("claude-sonnet-5.0")).toBe(true);
	});
});

describe("isAnthropicFableOrMythosModel", () => {
	it("returns true for claude-fable-1.0", () => {
		expect(isAnthropicFableOrMythosModel("claude-fable-1.0")).toBe(true);
	});
	it("returns true for claude-mythos-1.0", () => {
		expect(isAnthropicFableOrMythosModel("claude-mythos-1.0")).toBe(true);
	});
	it("returns false for claude-opus-4.7", () => {
		expect(isAnthropicFableOrMythosModel("claude-opus-4.7")).toBe(false);
	});
	it("returns false for non-anthropic", () => {
		expect(isAnthropicFableOrMythosModel("gpt-4")).toBe(false);
	});
});

describe("findThinkingVariantToken", () => {
	it("finds -thinking suffix", () => {
		const token = findThinkingVariantToken("model-thinking");
		expect(token).toBeDefined();
		expect(token?.index).toBe(5);
		expect(token?.length).toBe(9);
	});
	it("finds -reasoner suffix", () => {
		const token = findThinkingVariantToken("model-reasoner");
		expect(token).toBeDefined();
		expect(token?.length).toBe(9);
	});
	it("finds -reasoning suffix", () => {
		const token = findThinkingVariantToken("model-reasoning");
		expect(token).toBeDefined();
		expect(token?.length).toBe(10);
	});
	it("returns undefined for no token", () => {
		expect(findThinkingVariantToken("model")).toBeUndefined();
	});
	it("skips non-thinking prefix", () => {
		expect(findThinkingVariantToken("non-thinking")).toBeUndefined();
	});
	it("skips no-thinking prefix", () => {
		expect(findThinkingVariantToken("no-thinking")).toBeUndefined();
	});
	it("finds token at end of string", () => {
		const token = findThinkingVariantToken("gpt-4-thinking");
		expect(token).toBeDefined();
	});
	it("finds token followed by non-alphanumeric", () => {
		const token = findThinkingVariantToken("gpt-4-thinking-preview");
		expect(token).toBeDefined();
		expect(token?.index).toBe(5);
	});
});

describe("stripThinkingVariantToken", () => {
	it("strips -thinking suffix", () => {
		expect(stripThinkingVariantToken("model-thinking")).toBe("model");
	});
	it("strips -reasoner suffix", () => {
		expect(stripThinkingVariantToken("model-reasoner")).toBe("model");
	});
	it("returns undefined for no token", () => {
		expect(stripThinkingVariantToken("model")).toBeUndefined();
	});
	it("returns undefined for non-thinking", () => {
		expect(stripThinkingVariantToken("non-thinking")).toBeUndefined();
	});
	it("strips and joins remaining parts", () => {
		expect(stripThinkingVariantToken("gpt-4-thinking-preview")).toBe("gpt-4-preview");
	});
});
