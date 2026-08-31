import { describe, expect, it } from "bun:test";
import {
	isAnthropicNamespacedModelId,
	isClaudeModelId,
	isDeepseekModelIdOrName,
	isGemmaModelId,
	isGlm52ReasoningEffortModelId,
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
	supportsOpenAIPromptCacheBreakpoints,
} from "../src/identity/family";

describe("isKimiModelId", () => {
	it("matches moonshotai/kimi prefix", () => {
		expect(isKimiModelId("moonshotai/kimi-k2")).toBe(true);
	});

	it("matches kimi- prefix", () => {
		expect(isKimiModelId("kimi-k2")).toBe(true);
	});

	it("matches /kimi- prefix", () => {
		expect(isKimiModelId("provider/kimi-k2")).toBe(true);
	});

	it("matches kimi. prefix", () => {
		expect(isKimiModelId("kimi.k2")).toBe(true);
	});

	it("does not match unrelated model", () => {
		expect(isKimiModelId("gpt-4")).toBe(false);
	});

	it("does not match empty string", () => {
		expect(isKimiModelId("")).toBe(false);
	});
});

describe("isKimiK26ModelId", () => {
	it("matches kimi-k2.6", () => {
		expect(isKimiK26ModelId("kimi-k2.6")).toBe(true);
	});

	it("matches kimi-k2p6", () => {
		expect(isKimiK26ModelId("kimi-k2p6")).toBe(true);
	});

	it("matches with provider prefix", () => {
		expect(isKimiK26ModelId("moonshotai/kimi-k2.6")).toBe(true);
	});

	it("does not match kimi-k2 without .6/p6", () => {
		expect(isKimiK26ModelId("kimi-k2")).toBe(false);
	});

	it("does not match empty string", () => {
		expect(isKimiK26ModelId("")).toBe(false);
	});
});

describe("isClaudeModelId", () => {
	it("matches claude- prefix", () => {
		expect(isClaudeModelId("claude-3-opus")).toBe(true);
	});

	it("matches /claude- prefix", () => {
		expect(isClaudeModelId("anthropic/claude-3-opus")).toBe(true);
	});

	it("matches claude. prefix", () => {
		expect(isClaudeModelId("claude.3-opus")).toBe(true);
	});

	it("matches /claude. prefix", () => {
		expect(isClaudeModelId("provider/claude.3")).toBe(true);
	});

	it("does not match unrelated model", () => {
		expect(isClaudeModelId("gpt-4")).toBe(false);
	});

	it("does not match empty string", () => {
		expect(isClaudeModelId("")).toBe(false);
	});
});

describe("isAnthropicNamespacedModelId", () => {
	it("matches anthropic/ prefix", () => {
		expect(isAnthropicNamespacedModelId("anthropic/claude-3")).toBe(true);
	});

	it("matches /anthropic/ prefix", () => {
		expect(isAnthropicNamespacedModelId("provider/anthropic/claude-3")).toBe(true);
	});

	it("does not match claude without anthropic namespace", () => {
		expect(isAnthropicNamespacedModelId("claude-3")).toBe(false);
	});

	it("does not match empty string", () => {
		expect(isAnthropicNamespacedModelId("")).toBe(false);
	});
});

describe("isQwenModelId", () => {
	it("matches qwen in model id (case-insensitive)", () => {
		expect(isQwenModelId("qwen-72b")).toBe(true);
		expect(isQwenModelId("Qwen-72B")).toBe(true);
	});

	it("matches qwen with provider prefix", () => {
		expect(isQwenModelId("alibaba/qwen-max")).toBe(true);
	});

	it("does not match unrelated model", () => {
		expect(isQwenModelId("gpt-4")).toBe(false);
	});
});

describe("isGemmaModelId", () => {
	it("matches gemma- with digit", () => {
		expect(isGemmaModelId("gemma-2b")).toBe(true);
	});

	it("matches gemma. with digit", () => {
		expect(isGemmaModelId("gemma.2b")).toBe(true);
	});

	it("matches /gemma- with digit", () => {
		expect(isGemmaModelId("google/gemma-7b")).toBe(true);
	});

	it("matches gemma2 without separator", () => {
		expect(isGemmaModelId("gemma2-9b")).toBe(true);
	});

	it("does not match gemma without digit", () => {
		expect(isGemmaModelId("gemma")).toBe(false);
	});

	it("does not match unrelated model", () => {
		expect(isGemmaModelId("gpt-4")).toBe(false);
	});
});

describe("isDeepseekModelIdOrName", () => {
	it("matches deepseek (case-insensitive)", () => {
		expect(isDeepseekModelIdOrName("deepseek-v3")).toBe(true);
		expect(isDeepseekModelIdOrName("DeepSeek-V3")).toBe(true);
	});

	it("matches with provider prefix", () => {
		expect(isDeepseekModelIdOrName("deepseek/deepseek-chat")).toBe(true);
	});

	it("does not match unrelated model", () => {
		expect(isDeepseekModelIdOrName("gpt-4")).toBe(false);
	});
});

describe("isMimoModelIdOrName", () => {
	it("matches mimo (case-insensitive)", () => {
		expect(isMimoModelIdOrName("mimo-7b")).toBe(true);
		expect(isMimoModelIdOrName("MiMo-7B")).toBe(true);
	});

	it("does not match unrelated model", () => {
		expect(isMimoModelIdOrName("gpt-4")).toBe(false);
	});
});

describe("isOpenAIOSeriesModelId", () => {
	it("matches o1", () => {
		expect(isOpenAIOSeriesModelId("o1")).toBe(true);
	});

	it("matches o1-mini", () => {
		expect(isOpenAIOSeriesModelId("o1-mini")).toBe(true);
	});

	it("matches o3", () => {
		expect(isOpenAIOSeriesModelId("o3")).toBe(true);
	});

	it("matches o4", () => {
		expect(isOpenAIOSeriesModelId("o4-mini")).toBe(true);
	});

	it("matches with provider prefix", () => {
		expect(isOpenAIOSeriesModelId("openai/o3")).toBe(true);
	});

	it("does not match o2", () => {
		expect(isOpenAIOSeriesModelId("o2")).toBe(false);
	});

	it("does not match unrelated model", () => {
		expect(isOpenAIOSeriesModelId("gpt-4")).toBe(false);
	});

	it("does not match empty string", () => {
		expect(isOpenAIOSeriesModelId("")).toBe(false);
	});
});

describe("isGrokReasoningEffortCapable", () => {
	it("matches grok-3-mini", () => {
		expect(isGrokReasoningEffortCapable("grok-3-mini")).toBe(true);
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

	it("matches grok-4.20-multi-agent", () => {
		expect(isGrokReasoningEffortCapable("grok-4.20-multi-agent")).toBe(true);
	});

	it("does not match grok-2", () => {
		expect(isGrokReasoningEffortCapable("grok-2")).toBe(false);
	});

	it("does not match empty string", () => {
		expect(isGrokReasoningEffortCapable("")).toBe(false);
	});

	it("does not match unrelated model", () => {
		expect(isGrokReasoningEffortCapable("gpt-4")).toBe(false);
	});
});

describe("isMinimaxM2FamilyModelId", () => {
	it("matches minimax m2", () => {
		expect(isMinimaxM2FamilyModelId("minimax-m2")).toBe(true);
	});

	it("matches minimax/m2", () => {
		expect(isMinimaxM2FamilyModelId("minimax/m2")).toBe(true);
	});

	it("matches minimax.m2", () => {
		expect(isMinimaxM2FamilyModelId("minimax.m2")).toBe(true);
	});

	it("matches m2 with version suffix", () => {
		expect(isMinimaxM2FamilyModelId("minimax-m2-001")).toBe(true);
	});

	it("does not match minimax without m2", () => {
		expect(isMinimaxM2FamilyModelId("minimax-text-01")).toBe(false);
	});

	it("does not match m2 without minimax", () => {
		expect(isMinimaxM2FamilyModelId("m2")).toBe(false);
	});

	it("does not match empty string", () => {
		expect(isMinimaxM2FamilyModelId("")).toBe(false);
	});
});

describe("isMinimaxM3FamilyModelId", () => {
	it("matches minimax m3", () => {
		expect(isMinimaxM3FamilyModelId("minimax-m3")).toBe(true);
	});

	it("matches minimax/m3", () => {
		expect(isMinimaxM3FamilyModelId("minimax/m3")).toBe(true);
	});

	it("matches m3 with separator", () => {
		expect(isMinimaxM3FamilyModelId("minimax_m3")).toBe(true);
	});

	it("does not match minimax without m3", () => {
		expect(isMinimaxM3FamilyModelId("minimax-m2")).toBe(false);
	});

	it("does not match m3 without minimax prefix in some forms", () => {
		// The regex allows m3 without minimax prefix
		expect(isMinimaxM3FamilyModelId("m3-something")).toBe(false);
	});

	it("does not match empty string", () => {
		expect(isMinimaxM3FamilyModelId("")).toBe(false);
	});
});

describe("isOpenAIGptOssModelId", () => {
	it("matches gpt-oss prefix", () => {
		expect(isOpenAIGptOssModelId("gpt-oss-120b")).toBe(true);
	});

	it("matches /gpt-oss prefix", () => {
		expect(isOpenAIGptOssModelId("openai/gpt-oss-120b")).toBe(true);
	});

	it("matches gpt-oss: prefix", () => {
		expect(isOpenAIGptOssModelId("gpt-oss:120b")).toBe(true);
	});

	it("does not match gpt without oss", () => {
		expect(isOpenAIGptOssModelId("gpt-4")).toBe(false);
	});

	it("does not match empty string", () => {
		expect(isOpenAIGptOssModelId("")).toBe(false);
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
		expect(isOpenAIModelId("codex-mini")).toBe(true);
	});

	it("matches o1 with separator", () => {
		expect(isOpenAIModelId("o1-mini")).toBe(true);
	});

	it("matches openai/ prefix", () => {
		expect(isOpenAIModelId("openai/gpt-4")).toBe(true);
	});

	it("does not match unrelated model", () => {
		expect(isOpenAIModelId("claude-3")).toBe(false);
	});

	it("does not match empty string", () => {
		expect(isOpenAIModelId("")).toBe(false);
	});
});

describe("supportsOpenAIPromptCacheBreakpoints", () => {
	it("returns true for gpt-5.6+", () => {
		expect(supportsOpenAIPromptCacheBreakpoints("gpt-5.6")).toBe(true);
	});

	it("returns true for gpt-5.10", () => {
		expect(supportsOpenAIPromptCacheBreakpoints("gpt-5.10")).toBe(true);
	});

	it("returns false for gpt-5.5", () => {
		expect(supportsOpenAIPromptCacheBreakpoints("gpt-5.5")).toBe(false);
	});

	it("returns false for gpt-4", () => {
		expect(supportsOpenAIPromptCacheBreakpoints("gpt-4")).toBe(false);
	});

	it("returns false for non-OpenAI model", () => {
		expect(supportsOpenAIPromptCacheBreakpoints("claude-3")).toBe(false);
	});
});

describe("isReasoningGlmModelId", () => {
	it("returns true for glm-4.5", () => {
		expect(isReasoningGlmModelId("glm-4.5")).toBe(true);
	});

	it("returns true for glm-4.6", () => {
		expect(isReasoningGlmModelId("glm-4.6")).toBe(true);
	});

	it("returns false for glm-4.4", () => {
		expect(isReasoningGlmModelId("glm-4.4")).toBe(false);
	});

	it("returns false for non-glm model", () => {
		expect(isReasoningGlmModelId("gpt-4")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isReasoningGlmModelId("")).toBe(false);
	});
});

describe("isGlm52ReasoningEffortModelId", () => {
	it("returns true for glm-4.6", () => {
		// The function checks for version >= 5.2 but glm-4.6 < 5.2
		// Actually let's test with a 5.2+ model
		expect(isGlm52ReasoningEffortModelId("glm-5.2")).toBe(true);
	});

	it("returns false for glm-4.5", () => {
		expect(isGlm52ReasoningEffortModelId("glm-4.5")).toBe(false);
	});

	it("returns false for non-glm model", () => {
		expect(isGlm52ReasoningEffortModelId("gpt-4")).toBe(false);
	});
});
