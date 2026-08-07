import { describe, expect, it } from "bun:test";
import { buildModel } from "@veyyon/catalog/build";
import { canonicalizeEfforts, Effort } from "@veyyon/catalog/effort";
import {
	clampThinkingLevelForModel,
	getSupportedEfforts,
	mapEffortToAnthropicAdaptiveEffort,
	mapEffortToGoogleThinkingLevel,
	minimumSupportedEffort,
	requireSupportedEffort,
	resolveReasoningSelection,
} from "@veyyon/catalog/model-thinking";
import type { Api, Model, ModelSpec, Provider } from "@veyyon/catalog/types";

function createModel<TApi extends Api>(overrides: {
	id: string;
	api: TApi;
	provider: Provider;
	reasoning?: boolean;
	baseUrl?: string;
	compat?: ModelSpec<TApi>["compat"];
	thinking?: ModelSpec<TApi>["thinking"];
}): Model<TApi> {
	return buildModel({
		id: overrides.id,
		name: overrides.id,
		api: overrides.api,
		provider: overrides.provider,
		baseUrl: overrides.baseUrl ?? "",
		reasoning: overrides.reasoning ?? true,
		compat: overrides.compat,
		thinking: overrides.thinking,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	});
}

describe("model thinking derivation", () => {
	it("stores supported efforts for Codex mini in model metadata", () => {
		// The declared ladder (codex-mini accepts only medium/high on the wire)
		// flows through unchanged; unsupported tiers reject with the declared list.
		const model = createModel({
			id: "gpt-5.1-codex-mini",
			api: "openai-codex-responses",
			provider: "openai-codex",
			thinking: { mode: "effort", efforts: [Effort.Medium, Effort.High] },
		});

		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Medium, Effort.High],
		});
		expect(() => requireSupportedEffort(model, Effort.Low)).toThrow(/Supported efforts: medium, high/);
		expect(() => requireSupportedEffort(model, Effort.XHigh)).toThrow(/Supported efforts: medium, high/);
	});

	it("stores xhigh support directly in metadata for GPT-5.2", () => {
		const model = createModel({
			id: "gpt-5.2-codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
		});

		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		});
		expect(requireSupportedEffort(model, Effort.XHigh)).toBe(Effort.XHigh);
	});

	it("stores MiniMax M2 and GPT-OSS OpenAI-compatible effort limits in model metadata", () => {
		const minimax = createModel({
			id: "minimax-m2.7",
			api: "openai-completions",
			provider: "fireworks",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		});
		const gptOss = createModel({
			id: "gpt-oss-120b",
			api: "openai-completions",
			provider: "fireworks",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		});

		expect(minimax.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High],
			// MiniMax M2 is a reasoning-first architecture — thinking-off clamps.
			requiresEffort: true,
		});
		expect(gptOss.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High],
		});
		expect(minimax.thinking?.effortMap).toBeUndefined();
		expect(gptOss.thinking?.effortMap).toBeUndefined();
	});

	it("stores MiMo OpenAI-compatible effort limits in model metadata", () => {
		const mimo = createModel({
			id: "mimo-v2.5-pro",
			api: "openai-completions",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		});
		const openRouterMimo = createModel({
			id: "xiaomi/mimo-v2.5-pro",
			api: "openrouter",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		});

		const expectedThinking = {
			mode: "effort" as const,
			efforts: [Effort.Low, Effort.Medium, Effort.High],
		};
		expect(mimo.thinking).toEqual(expectedThinking);
		expect(openRouterMimo.thinking).toEqual(expectedThinking);
		// The MiMo wire map (minimal->low, xhigh->high) is a compat wire fact and
		// still derives from identity; only the displayed ladder is declared data.
		expect(mimo.compat.reasoningEffortMap).toEqual({ minimal: "low", xhigh: "high" });
		expect(openRouterMimo.compat.reasoningEffortMap).toEqual({ minimal: "low", xhigh: "high" });
		expect(requireSupportedEffort(mimo, Effort.High)).toBe(Effort.High);
		expect(() => requireSupportedEffort(mimo, Effort.XHigh)).toThrow(/Supported efforts: low, medium, high/);
		expect(clampThinkingLevelForModel(mimo, Effort.Minimal)).toBe(Effort.Low);
		expect(clampThinkingLevelForModel(mimo, Effort.XHigh)).toBe(Effort.High);

		// Nothing declared: no surface, even on the native Xiaomi host. models.dev
		// does not catalog xiaomi, so no effort ladder is fabricated from the id.
		const nativeXiaomi = createModel({
			id: "mimo-v2.5-pro",
			api: "openai-completions",
			provider: "xiaomi",
			baseUrl: "https://api.xiaomimimo.com/v1",
		});
		expect(nativeXiaomi.thinking).toBeUndefined();
	});

	it("keeps stale declared MiniMax M2 / GPT-OSS ladders as authored, backfilling wire facts", () => {
		// A cache row from the fabrication era carries its authored ladder; the
		// build canonicalizes and backfills wire facts but never rewrites the
		// declared tier set from identity. Refresh (2h cache TTL) is what replaces
		// the stale ladder with the models.dev-declared one.
		const staleMinimax = createModel({
			id: "minimax-m2.7",
			api: "openai-completions",
			provider: "fireworks",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			thinking: {
				mode: "effort",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				effortMap: { minimal: "none", xhigh: "max" },
			},
		});
		const staleGptOss = createModel({
			id: "gpt-oss-120b",
			api: "openai-completions",
			provider: "fireworks",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			thinking: {
				mode: "effort",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			},
		});

		expect(staleMinimax.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			effortMap: { minimal: "none", xhigh: "max" },
			requiresEffort: true,
		});
		expect(staleGptOss.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			// Map-less declared thinking gains the detected Fireworks wire quirk.
			effortMap: { minimal: "none" },
		});
	});

	it("stores OpenAI-compatible provider effort maps in thinking metadata", () => {
		const fireworks = createModel({
			id: "glm-5.1",
			api: "openai-completions",
			provider: "fireworks",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			thinking: {
				mode: "effort",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.Max],
			},
		});
		const groqQwen = createModel({
			id: "qwen/qwen3-32b",
			api: "openai-completions",
			provider: "groq",
			baseUrl: "https://api.groq.com/openai/v1",
			thinking: { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		});
		const deepseek = createModel({
			id: "deepseek-v4-flash",
			api: "openai-completions",
			provider: "deepseek",
			baseUrl: "https://api.deepseek.com/v1",
			compat: { reasoningEffortMap: { max: "max-plus" } },
			thinking: { mode: "effort", efforts: [Effort.High, Effort.Max] },
		});
		const openRouterAnthropic = createModel({
			id: "anthropic/claude-opus-4.7",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			},
		});

		// Wire maps are host facts: they attach around the declared ladder.
		expect(fireworks.thinking?.effortMap).toEqual({ minimal: "none" });
		expect(groqQwen.thinking?.effortMap).toEqual({
			minimal: "default",
			low: "default",
			medium: "default",
			high: "default",
		});
		// Explicit compat overrides win over the detected wire values.
		expect(getSupportedEfforts(deepseek)).toEqual([Effort.High, Effort.Max]);
		expect(deepseek.thinking?.effortMap).toEqual({ max: "max-plus" });
		// OpenRouter-hosted Anthropic adaptive models pass the declared ladder
		// through with no remapping.
		expect(getSupportedEfforts(openRouterAnthropic)).toEqual([
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
			Effort.Max,
		]);
		expect(openRouterAnthropic.thinking?.effortMap).toBeUndefined();
	});

	it("derives Anthropic adaptive thinking for SAP hai-proxy version-first Claude ids", () => {
		const opus48 = createModel({
			id: "anthropic--claude-4.8-opus",
			api: "anthropic-messages",
			provider: "custom",
			thinking: {
				mode: "anthropic-adaptive",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			},
		});
		const opus46 = createModel({
			id: "anthropic--claude-4.6-opus",
			api: "anthropic-messages",
			provider: "custom",
			thinking: { mode: "anthropic-adaptive", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max] },
		});

		expect(opus48.thinking).toEqual({
			mode: "anthropic-adaptive",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			supportsDisplay: true,
		});
		expect(getSupportedEfforts(opus48)).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);
		expect(opus46.thinking).toEqual({
			mode: "anthropic-adaptive",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max],
		});
	});

	it("maps GLM-5.2 reasoning effort per host dialect", () => {
		const zai = createModel({
			id: "glm-5.2",
			api: "openai-completions",
			provider: "zai",
			baseUrl: "https://api.z.ai/api/paas/v4",
			// models.dev zai glm-5.2: high/max (none disables).
			thinking: { mode: "effort", efforts: [Effort.High, Effort.Max] },
		});
		const fireworks = createModel({
			id: "glm-5.2",
			api: "openai-completions",
			provider: "fireworks",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			thinking: {
				mode: "effort",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.Max],
			},
		});
		const openRouter = createModel({
			id: "z-ai/glm-5.2",
			api: "openrouter",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			// models.dev openrouter z-ai/glm-5.2: high/xhigh.
			thinking: { mode: "effort", efforts: [Effort.High, Effort.XHigh] },
		});

		expect(getSupportedEfforts(zai)).toEqual([Effort.High, Effort.Max]);
		expect(zai.thinking?.effortMap).toBeUndefined();
		// Fireworks keeps its distinct lower tiers and the `minimal -> none`
		// host quirk; the genuine `max` tier sits above `high`.
		expect(getSupportedEfforts(fireworks)).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.Max,
		]);
		expect(fireworks.thinking?.effortMap).toEqual({ minimal: "none" });
		// OpenRouter passes the declared xhigh tier through unmapped.
		expect(getSupportedEfforts(openRouter)).toContain(Effort.XHigh);
		expect(openRouter.thinking?.effortMap).toBeUndefined();
	});

	it("encodes the Gemini 3 Pro effort gap and mandatory reasoning in metadata", () => {
		const model = createModel({
			id: "gemini-3-pro-preview",
			api: "google-generative-ai",
			provider: "google",
			// models.dev google gemini-3-pro-preview: low/high, no medium tier.
			thinking: { mode: "google-level", efforts: [Effort.Low, Effort.High] },
		});

		expect(model.thinking).toEqual({
			mode: "google-level",
			efforts: [Effort.Low, Effort.High],
			requiresEffort: true,
		});
		expect(mapEffortToGoogleThinkingLevel(Effort.Low)).toBe("LOW");
		expect(mapEffortToGoogleThinkingLevel(Effort.High)).toBe("HIGH");
		expect(mapEffortToGoogleThinkingLevel(Effort.XHigh)).toBe("HIGH");
		expect(() => requireSupportedEffort(model, Effort.Medium)).toThrow(/not supported/);
	});

	it("bakes requiresEffort for Gemini 3.x on any provider and backfills explicit metadata", () => {
		// The mandatory-reasoning floor is a wire fact: it backfills onto any
		// declared ladder (models.dev gemini-3.5-flash: minimal/low/medium/high),
		// on any provider. Gemini 2.5 keeps the off switch.
		const openRouterFlash = createModel({
			id: "google/gemini-3.5-flash",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			thinking: { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		});
		expect(openRouterFlash.thinking?.requiresEffort).toBe(true);

		const legacyFlash = createModel({
			id: "gemini-2.5-flash",
			api: "google-generative-ai",
			provider: "google",
			thinking: { mode: "google-level", efforts: [Effort.Low, Effort.High] },
		});
		expect(legacyFlash.thinking?.requiresEffort).toBeUndefined();

		// Backfill: explicit (pre-flag) baked thinking gains the wire fact;
		// explicit `false` wins over identity.
		const baked = createModel({
			id: "gemini-3.1-pro-preview",
			api: "google-generative-ai",
			provider: "google",
			thinking: { mode: "google-level", efforts: [Effort.Low, Effort.High] },
		});
		expect(baked.thinking?.requiresEffort).toBe(true);

		const optedOut = createModel({
			id: "gemini-3.1-pro-preview",
			api: "google-generative-ai",
			provider: "google",
			thinking: { mode: "google-level", efforts: [Effort.Low, Effort.High], requiresEffort: false },
		});
		expect(optedOut.thinking?.requiresEffort).toBe(false);

		// Floor selection follows canonical order, not array order.
		expect(minimumSupportedEffort(baked)).toBe(Effort.Low);
		expect(minimumSupportedEffort(openRouterFlash)).toBe(Effort.Minimal);
	});

	it("flags reasoning-only families and thinking-variant orphans", () => {
		// The mandatory-reasoning floor backfills onto any declared ladder;
		// without one, nothing is offered at all.
		const declared = { mode: "effort" as const, efforts: [Effort.Low, Effort.High] };
		expect(
			createModel({
				id: "openai/o3-mini",
				api: "openai-completions",
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				thinking: declared,
			}).thinking?.requiresEffort,
		).toBe(true);
		expect(
			createModel({ id: "minimax-m2.7", api: "openai-completions", provider: "fireworks", thinking: declared })
				.thinking?.requiresEffort,
		).toBe(true);
		expect(
			createModel({ id: "kimi-k2-thinking", api: "openai-completions", provider: "venice", thinking: declared })
				.thinking?.requiresEffort,
		).toBe(true);
		expect(
			createModel({ id: "deepseek-reasoner", api: "openai-completions", provider: "deepseek", thinking: declared })
				.thinking?.requiresEffort,
		).toBe(true);
		// Negated tokens name the NON-thinking SKU.
		expect(
			createModel({
				id: "deepseek-non-thinking-v3.2-exp",
				api: "openai-completions",
				provider: "aimlapi",
				thinking: declared,
			}).thinking?.requiresEffort,
		).toBeUndefined();
		// Gemini 2.5: Pro floors thinkingBudget at 128; Flash keeps the off switch.
		expect(
			createModel({ id: "gemini-2.5-pro", api: "google-generative-ai", provider: "google", thinking: declared })
				.thinking?.requiresEffort,
		).toBe(true);
	});

	it("encodes anthropic transport mode and adaptive wire maps in metadata", () => {
		// Ladders are declared data (models.dev); what identity still owns here is
		// the transport mode and the wire encoding around the declared ladder.
		const opus45 = createModel({
			id: "claude-opus-4-5",
			api: "anthropic-messages",
			provider: "anthropic",
			thinking: { mode: "anthropic-budget-effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		});
		const opus46 = createModel({
			id: "claude-opus-4.6",
			api: "anthropic-messages",
			provider: "anthropic",
			thinking: { mode: "anthropic-adaptive", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max] },
		});
		const opus47 = createModel({
			id: "claude-opus-4.7",
			api: "anthropic-messages",
			provider: "anthropic",
			thinking: {
				mode: "anthropic-adaptive",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			},
		});
		const opus46Bedrock = createModel({
			id: "us.anthropic.claude-opus-4-6-v1",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			thinking: { mode: "anthropic-adaptive", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max] },
		});
		const opus47Bedrock = createModel({
			id: "us.anthropic.claude-opus-4-7",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			thinking: {
				mode: "anthropic-adaptive",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			},
		});
		const sonnet46 = createModel({
			id: "claude-sonnet-4.6",
			api: "anthropic-messages",
			provider: "anthropic",
			thinking: { mode: "anthropic-adaptive", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		});
		const sonnet5 = createModel({
			id: "claude-sonnet-5",
			api: "anthropic-messages",
			provider: "anthropic",
			thinking: {
				mode: "anthropic-adaptive",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			},
		});
		const sonnet5Bedrock = createModel({
			id: "global.anthropic.claude-sonnet-5",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			thinking: {
				mode: "anthropic-adaptive",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			},
		});
		const mythos = createModel({
			id: "claude-mythos-5",
			api: "anthropic-messages",
			provider: "anthropic",
			thinking: {
				mode: "anthropic-adaptive",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			},
		});
		const mythosBedrock = createModel({
			id: "global.anthropic.claude-mythos-5",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			thinking: {
				mode: "anthropic-adaptive",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			},
		});
		const minimaxM2 = createModel({
			id: "MiniMax-M2.7",
			api: "anthropic-messages",
			provider: "minimax",
			thinking: { mode: "anthropic-adaptive", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		});
		const minimaxM3 = createModel({
			id: "MiniMax-M3",
			api: "anthropic-messages",
			provider: "minimax",
			thinking: { mode: "anthropic-adaptive", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		});

		// Direct Anthropic Claude 4.5: Opus 4.5 supports `output_config.effort`
		// (sent alongside `thinking.budget_tokens`), Sonnet 4.5 and Haiku 4.5
		// reject the field with HTTP 400 "This model does not support the effort
		// parameter." (#3497).
		expect(opus45.thinking?.mode).toBe("anthropic-budget-effort");
		const opus45Bedrock = createModel({
			id: "us.anthropic.claude-opus-4-5-20251101",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			thinking: { mode: "anthropic-budget-effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		});
		expect(opus45Bedrock.thinking?.mode).toBe("anthropic-budget-effort");
		const sonnet45 = createModel({
			id: "claude-sonnet-4-5",
			api: "anthropic-messages",
			provider: "anthropic",
			thinking: { mode: "budget", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		});
		expect(sonnet45.thinking?.mode).toBe("budget");
		const haiku45 = createModel({
			id: "claude-haiku-4-5",
			api: "anthropic-messages",
			provider: "anthropic",
			thinking: { mode: "budget", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		});
		expect(haiku45.thinking?.mode).toBe("budget");
		const sonnet45Bedrock = createModel({
			id: "us.anthropic.claude-sonnet-4-5-20250929",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			thinking: { mode: "budget", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		});
		expect(sonnet45Bedrock.thinking?.mode).toBe("budget");
		expect(opus46.thinking?.mode).toBe("anthropic-adaptive");
		expect(sonnet46.thinking?.mode).toBe("anthropic-adaptive");
		expect(sonnet5.thinking?.mode).toBe("anthropic-adaptive");
		expect(sonnet5Bedrock.thinking?.mode).toBe("anthropic-adaptive");
		expect(mythosBedrock.thinking?.mode).toBe("anthropic-adaptive");
		expect(minimaxM2.thinking).toEqual({
			mode: "anthropic-adaptive",
			efforts: [Effort.Low, Effort.Medium, Effort.High],
			effortMap: {
				low: "adaptive",
				medium: "adaptive",
				high: "adaptive",
			},
			requiresEffort: true,
		});
		expect(minimaxM3.thinking).toEqual({
			mode: "anthropic-adaptive",
			efforts: [Effort.Low, Effort.Medium, Effort.High],
			effortMap: {
				low: "adaptive",
				medium: "adaptive",
				high: "adaptive",
			},
		});
		expect(mapEffortToAnthropicAdaptiveEffort(minimaxM3, Effort.High)).toBe("adaptive");
		// Opus 4.6 has no real xhigh tier — the declared ladder is the four-tier
		// low/medium/high/max wire scale, mapped 1:1.
		expect(getSupportedEfforts(opus46)).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.Max]);
		expect(opus46.thinking?.effortMap).toBeUndefined();
		expect(mapEffortToAnthropicAdaptiveEffort(opus46, Effort.Max)).toBe("max");
		expect(() => mapEffortToAnthropicAdaptiveEffort(opus46, Effort.XHigh)).toThrow(/not supported/);
		// Opus 4.7+ on the Messages API exposes the full five-tier wire scale
		// low..max with no remapping.
		expect(getSupportedEfforts(opus47)).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);
		expect(opus47.thinking?.effortMap).toBeUndefined();
		expect(mapEffortToAnthropicAdaptiveEffort(opus47, Effort.Low)).toBe("low");
		expect(mapEffortToAnthropicAdaptiveEffort(opus47, Effort.High)).toBe("high");
		expect(mapEffortToAnthropicAdaptiveEffort(opus47, Effort.XHigh)).toBe("xhigh");
		expect(mapEffortToAnthropicAdaptiveEffort(opus47, Effort.Max)).toBe("max");
		expect(() => mapEffortToAnthropicAdaptiveEffort(opus47, Effort.Minimal)).toThrow(/not supported/);
		expect(mapEffortToAnthropicAdaptiveEffort(mythos, Effort.XHigh)).toBe("xhigh");
		expect(mapEffortToAnthropicAdaptiveEffort(sonnet5, Effort.Max)).toBe("max");
		// Bedrock Converse serves the same ladder: it resolves the same models to
		// `anthropic-adaptive` and sends the tier as `output_config.effort` from
		// the same mapper, so `xhigh` reaches the model on either host.
		expect(getSupportedEfforts(opus47Bedrock)).toEqual([
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
			Effort.Max,
		]);
		expect(opus47Bedrock.thinking?.effortMap).toBeUndefined();
		expect(mapEffortToAnthropicAdaptiveEffort(opus47Bedrock, Effort.High)).toBe("high");
		expect(mapEffortToAnthropicAdaptiveEffort(opus47Bedrock, Effort.XHigh)).toBe("xhigh");
		expect(mapEffortToAnthropicAdaptiveEffort(opus47Bedrock, Effort.Max)).toBe("max");
		expect(mapEffortToAnthropicAdaptiveEffort(sonnet5Bedrock, Effort.XHigh)).toBe("xhigh");
		expect(mapEffortToAnthropicAdaptiveEffort(sonnet5Bedrock, Effort.Max)).toBe("max");
		// A pre-4.7 Bedrock adaptive row still has no fifth tier to offer.
		expect(getSupportedEfforts(opus46Bedrock)).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.Max]);
		expect(() => mapEffortToAnthropicAdaptiveEffort(opus46Bedrock, Effort.XHigh)).toThrow(/not supported/);
		// Sonnet 4.6 runs adaptive mode on the three-tier low/medium/high scale.
		expect(getSupportedEfforts(sonnet46)).toEqual([Effort.Low, Effort.Medium, Effort.High]);
		expect(() => mapEffortToAnthropicAdaptiveEffort(sonnet46, Effort.XHigh)).toThrow(/not supported/);
		expect(() => mapEffortToAnthropicAdaptiveEffort(sonnet46, Effort.Max)).toThrow(/not supported/);
	});

	it("bakes adaptive display support for Opus 4.7+, Sonnet 5+, and Fable/Mythos 5", () => {
		const declared = { mode: "effort" as const, efforts: [Effort.Low, Effort.Medium, Effort.High] };
		const opus46 = createModel({
			id: "claude-opus-4.6",
			api: "anthropic-messages",
			provider: "anthropic",
			thinking: declared,
		});
		const opus47 = createModel({
			id: "claude-opus-4-7",
			api: "anthropic-messages",
			provider: "anthropic",
			thinking: declared,
		});
		// Dotted and dashed version forms are equivalent; bare dated ids stay Opus 4.0.
		const opus47Dotted = createModel({
			id: "claude-opus-4.7",
			api: "anthropic-messages",
			provider: "anthropic",
			thinking: declared,
		});
		const opus4Dated = createModel({
			id: "claude-opus-4-20250514",
			api: "anthropic-messages",
			provider: "anthropic",
			thinking: declared,
		});
		const fable = createModel({
			id: "claude-fable-5",
			api: "anthropic-messages",
			provider: "anthropic",
			thinking: declared,
		});
		const fableBedrock = createModel({
			id: "global.anthropic.claude-fable-5",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			thinking: declared,
		});
		const sonnet5 = createModel({
			id: "claude-sonnet-5",
			api: "anthropic-messages",
			provider: "anthropic",
			thinking: declared,
		});
		const sonnet5Bedrock = createModel({
			id: "global.anthropic.claude-sonnet-5",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			thinking: declared,
		});

		expect(opus46.thinking?.supportsDisplay).toBeUndefined();
		expect(opus47.thinking?.supportsDisplay).toBe(true);
		expect(opus47Dotted.thinking?.supportsDisplay).toBe(true);
		expect(opus4Dated.thinking?.supportsDisplay).toBeUndefined();
		expect(fable.thinking?.supportsDisplay).toBe(true);
		expect(fableBedrock.thinking?.supportsDisplay).toBe(true);
		expect(sonnet5.thinking?.supportsDisplay).toBe(true);
		expect(sonnet5Bedrock.thinking?.supportsDisplay).toBe(true);
	});

	it("backfills wire facts onto explicit thinking, explicit values winning", () => {
		// An authored ladder stands verbatim (canonical order); the build only
		// backfills wire facts (here: adaptive display for Opus 4.8) around it.
		const filled = createModel({
			id: "claude-opus-4-8",
			api: "anthropic-messages",
			provider: "anthropic",
			thinking: { mode: "anthropic-adaptive", efforts: [Effort.Low, Effort.High] },
		});
		expect(filled.thinking).toEqual({
			mode: "anthropic-adaptive",
			efforts: [Effort.Low, Effort.High],
			supportsDisplay: true,
		});

		// Explicit wire facts are authoritative — including `false`.
		const pinned = createModel({
			id: "claude-opus-4-8",
			api: "anthropic-messages",
			provider: "anthropic",
			thinking: {
				mode: "anthropic-adaptive",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
				effortMap: { max: "ultra" },
				supportsDisplay: false,
			},
		});
		expect(pinned.thinking?.effortMap).toEqual({ max: "ultra" });
		expect(pinned.thinking?.supportsDisplay).toBe(false);
	});

	it("treats explicit thinking metadata without efforts as no declared surface", () => {
		// A `mode` with no ladder declares nothing: the build must not invent
		// tiers from the model id to fill the gap.
		const model = buildModel(
			JSON.parse(`{
				"id": "gpt-5",
				"name": "gpt-5",
				"api": "openai-completions",
				"provider": "openai",
				"baseUrl": "",
				"reasoning": true,
				"thinking": { "mode": "effort" },
				"input": ["text"],
				"cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
				"contextWindow": 200000,
				"maxTokens": 32000
			}`),
		);

		expect(model.thinking).toBeUndefined();
	});

	it("bakes sampling-param rejection into anthropic compat", () => {
		const sonnet45 = createModel({ id: "claude-sonnet-4-5", api: "anthropic-messages", provider: "anthropic" });
		const opus47 = createModel({ id: "claude-opus-4.7", api: "anthropic-messages", provider: "anthropic" });
		const sonnet5 = createModel({ id: "claude-sonnet-5", api: "anthropic-messages", provider: "anthropic" });
		const fable = createModel({ id: "claude-fable-5", api: "anthropic-messages", provider: "anthropic" });

		expect(sonnet45.compat.supportsSamplingParams).toBe(true);
		expect(opus47.compat.supportsSamplingParams).toBe(false);
		expect(sonnet5.compat.supportsSamplingParams).toBe(false);
		expect(fable.compat.supportsSamplingParams).toBe(false);
	});

	it("encodes effort-dial-less reasoners as thinking: undefined", () => {
		// grok-4.20-0309-reasoning thinks natively but rejects the wire
		// `reasoning.effort` param (grok-build used to be the fixture here, but
		// it DOES accept the dial and is on the effort-capable allowlist).
		const model = createModel({
			id: "grok-4.20-0309-reasoning",
			api: "openai-responses",
			provider: "xai-oauth",
			compat: { supportsReasoningEffort: false },
		});

		expect(model.reasoning).toBe(true);
		expect(model.thinking).toBeUndefined();
		expect(getSupportedEfforts(model)).toEqual([]);
		expect(clampThinkingLevelForModel(model, Effort.High)).toBeUndefined();
	});

	it("keeps grok-build effort-capable on the wire without fabricating a ladder", () => {
		// Regression lock: grok-build was curated `supportsReasoningEffort:
		// false`, which stripped its thinking dial entirely — the model DOES
		// accept the wire effort param, so the compat allowlist must keep it
		// effort-capable. But models.dev declares no effort levels for grok-build,
		// so no ladder is fabricated from identity either.
		const model = createModel({
			id: "grok-build",
			api: "openai-responses",
			provider: "xai-oauth",
		});

		expect(model.reasoning).toBe(true);
		expect((model.compat as { supportsReasoningEffort?: boolean }).supportsReasoningEffort).not.toBe(false);
		expect(model.thinking).toBeUndefined();
	});

	it("explains the no-effort-surface case instead of listing zero supported efforts", () => {
		// Locks the error contract for reasoning models with no controllable
		// effort dial (thinking: undefined). The old message ended
		// "Supported efforts: " with an EMPTY list — it read as truncated, named
		// no cause, and offered no fix (seen live 2026-07-22 when a persisted
		// `high` level hit devin/swe-1-6 and killed every turn). The message must
		// state that the model exposes no controllable efforts and how to proceed.
		const model = createModel({
			id: "grok-4.20-0309-reasoning",
			api: "openai-responses",
			provider: "xai-oauth",
			compat: { supportsReasoningEffort: false },
		});

		expect(() => requireSupportedEffort(model, Effort.High)).toThrow(/no controllable thinking efforts/);
		expect(() => requireSupportedEffort(model, Effort.High)).not.toThrow(/Supported efforts:\s*$/);
	});

	it("never fabricates the GPT-5.6 ladder; declared surfaces stand as authored", () => {
		// The bundled openai-codex rows carry the models.dev-declared low..max
		// ladder. A bare spec with no declaration gets nothing — identity must not
		// invent tiers.
		const codex = createModel({
			id: "gpt-5.6-sol",
			api: "openai-codex-responses",
			provider: "openai-codex",
		});
		expect(codex.thinking).toBeUndefined();

		// Stale baked metadata (caches/discovery) keeps its authored ladder and
		// map; canonicalization is the only rewrite. The 2h cache TTL and the
		// models.dev overlay are what converge stale rows onto declared truth.
		const staleOpenRouter = createModel({
			id: "openai/gpt-5.6-terra",
			api: "openrouter",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			thinking: {
				mode: "effort",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				effortMap: {
					minimal: "low",
					low: "medium",
					medium: "high",
					high: "xhigh",
					xhigh: "max",
				},
			},
		});

		expect(staleOpenRouter.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			effortMap: {
				minimal: "low",
				low: "medium",
				medium: "high",
				high: "xhigh",
				xhigh: "max",
			},
		});
	});

	it("keeps pre-5.6 and Devin-routed GPT models on their own effort surfaces", () => {
		const gpt55 = createModel({
			id: "gpt-5.5",
			api: "openai-responses",
			provider: "openai",
			// models.dev openai gpt-5.5: low..xhigh (none disables).
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
		});

		expect(gpt55.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		});
		expect(gpt55.thinking?.effortMap).toBeUndefined();

		// Devin selects effort by routing to per-tier sibling model ids, never
		// via a wire reasoning.effort field — no effort map may attach.
		const devin = createModel({
			id: "gpt-5-6-sol",
			api: "devin-agent",
			provider: "devin",
			baseUrl: "https://server.codeium.com",
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
				effortRouting: {
					off: "gpt-5-6-sol-none",
					low: "gpt-5-6-sol-low",
					medium: "gpt-5-6-sol-medium",
					high: "gpt-5-6-sol-high",
					xhigh: "gpt-5-6-sol-xhigh",
					max: "gpt-5-6-sol-max",
				},
			},
		});

		expect(devin.thinking?.effortMap).toBeUndefined();
		expect(devin.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);
	});
	it("classifies Z.ai GLM-5.2 on the anthropic-messages coding endpoint as budget-effort with high/max", () => {
		// Z.ai's anthropic-messages proxy (api.z.ai/api/anthropic) serves
		// GLM-5.2 with the two-tier high/max scale models.dev declares for it.
		// The catalog must derive mode:"anthropic-budget-effort" (not plain
		// "budget") so the wire encoder emits output_config.effort instead of
		// only thinking.budget_tokens.
		const model = createModel({
			id: "glm-5.2",
			api: "anthropic-messages",
			provider: "zai",
			baseUrl: "https://api.z.ai/api/anthropic",
			thinking: { mode: "anthropic-budget-effort", efforts: [Effort.High, Effort.Max] },
		});

		expect(model.thinking?.mode).toBe("anthropic-budget-effort");
		expect(getSupportedEfforts(model)).toEqual([Effort.High, Effort.Max]);
		expect(model.thinking?.effortMap).toBeUndefined();
	});
});

describe("model thinking runtime helpers", () => {
	it("clamps from explicit metadata instead of inferring from model id", () => {
		const model = createModel({
			id: "custom-reasoner",
			api: "openai-codex-responses",
			provider: "custom",
			baseUrl: "https://example.com",
			thinking: { mode: "effort", efforts: [Effort.Medium, Effort.High] },
		});

		// `-reasoner` ids are thinking-only SKUs — the wire fact is backfilled
		// onto explicit metadata like effortMap.
		expect(model.thinking).toEqual({ mode: "effort", efforts: [Effort.Medium, Effort.High], requiresEffort: true });
		expect(clampThinkingLevelForModel(model, Effort.Minimal)).toBe(Effort.Medium);
		expect(clampThinkingLevelForModel(model, Effort.XHigh)).toBe(Effort.High);
		expect(clampThinkingLevelForModel(model, Effort.High)).toBe(Effort.High);
	});

	it('forces "off" for non-reasoning models', () => {
		const model = createModel({
			id: "plain-model",
			api: "openai-responses",
			provider: "openai",
			reasoning: false,
		});

		expect(clampThinkingLevelForModel(model, Effort.High)).toBeUndefined();
	});

	it("passes a declared xhigh tier through on openai-completions custom models", () => {
		const model = createModel({
			id: "custom-model",
			api: "openai-completions",
			provider: "custom",
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
		});

		expect(model.thinking?.efforts.at(-1)).toBe(Effort.XHigh);
		expect(requireSupportedEffort(model, Effort.XHigh)).toBe(Effort.XHigh);
	});

	it("does not expose xhigh for binary-thinking openai-compat transports", () => {
		const model = createModel({
			id: "glm-4.7",
			api: "openai-completions",
			provider: "zai",
			baseUrl: "https://api.z.ai/v1",
			compat: { thinkingFormat: "zai" },
			thinking: { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		});

		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		});
		expect(requireSupportedEffort(model, Effort.High)).toBe(Effort.High);
		expect(() => requireSupportedEffort(model, Effort.XHigh)).toThrow(
			/Supported efforts: minimal, low, medium, high/,
		);
	});

	it("exposes the Z.AI GLM-5.2 high/max wire pair directly", () => {
		const model = createModel({
			id: "glm-5.2",
			api: "openai-completions",
			provider: "zhipu-coding-plan",
			baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
			compat: { thinkingFormat: "zai" },
			thinking: { mode: "effort", efforts: [Effort.High, Effort.Max] },
		});

		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.High, Effort.Max],
		});
		expect(requireSupportedEffort(model, Effort.Max)).toBe(Effort.Max);
		expect(() => requireSupportedEffort(model, Effort.XHigh)).toThrow(/Supported efforts: high, max/);
		// Selecting a retired tier clamps down instead of erroring in UI flows.
		expect(clampThinkingLevelForModel(model, Effort.XHigh)).toBe(Effort.High);
	});

	it("exposes Ollama Cloud GLM-5.2 high/max and hides unsupported lower efforts", () => {
		const model = createModel({
			id: "glm-5.2",
			api: "ollama-chat",
			provider: "ollama-cloud",
			baseUrl: "https://ollama.com",
		});

		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.High, Effort.Max],
		});
		expect(requireSupportedEffort(model, Effort.High)).toBe(Effort.High);
		expect(requireSupportedEffort(model, Effort.Max)).toBe(Effort.Max);
		expect(() => requireSupportedEffort(model, Effort.Medium)).toThrow(/Supported efforts: high, max/);
	});

	it("caps tiers at the declared ladder when catalog compat is partial", () => {
		const model = createModel({
			id: "qwen/qwen3-32b",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			compat: { supportsToolChoice: true },
			thinking: { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		});

		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		});
		expect(requireSupportedEffort(model, Effort.High)).toBe(Effort.High);
		expect(() => requireSupportedEffort(model, Effort.XHigh)).toThrow(
			/Supported efforts: minimal, low, medium, high/,
		);
	});

	it("exposes wire-exact adaptive ladders for OpenRouter-hosted Anthropic models", () => {
		// Ladder values are the models.dev openrouter declarations.
		const fable = createModel({
			id: "anthropic/claude-fable-5",
			api: "openai-completions",
			provider: "openrouter",
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			},
		});
		const opus46 = createModel({
			id: "anthropic/claude-opus-4.6",
			api: "openai-completions",
			provider: "openrouter",
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max] },
		});
		const sonnet46 = createModel({
			id: "anthropic/claude-sonnet-4.6",
			api: "openai-completions",
			provider: "openrouter",
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		});
		const sonnet5 = createModel({
			id: "anthropic/claude-sonnet-5",
			api: "openai-completions",
			provider: "openrouter",
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			},
		});
		expect(fable.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);
		expect(opus46.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.Max]);
		expect(sonnet46.thinking?.efforts.at(-1)).toBe(Effort.High);
		expect(sonnet5.thinking?.efforts.at(-1)).toBe(Effort.Max);
		expect(requireSupportedEffort(fable, Effort.Max)).toBe(Effort.Max);
		expect(requireSupportedEffort(sonnet5, Effort.XHigh)).toBe(Effort.XHigh);
		expect(() => requireSupportedEffort(opus46, Effort.XHigh)).toThrow(/not supported/);
	});

	it("passes a declared xhigh tier through on openai-responses and openai-codex-responses APIs", () => {
		const responsesModel = createModel({
			id: "custom-responses",
			api: "openai-responses",
			provider: "custom",
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
		});
		const codexModel = createModel({
			id: "custom-codex",
			api: "openai-codex-responses",
			provider: "custom",
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
		});

		expect(responsesModel.thinking?.efforts.at(-1)).toBe(Effort.XHigh);
		expect(codexModel.thinking?.efforts.at(-1)).toBe(Effort.XHigh);
		expect(requireSupportedEffort(responsesModel, Effort.XHigh)).toBe(Effort.XHigh);
		expect(requireSupportedEffort(codexModel, Effort.XHigh)).toBe(Effort.XHigh);
	});

	it("rejects effort requests against un-built reasoning specs", () => {
		const spec = {
			id: "broken-reasoner",
			name: "Broken Reasoner",
			api: "openai-responses",
			provider: "custom",
			baseUrl: "https://example.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 32000,
		} as ModelSpec<"openai-responses">;

		expect(() => requireSupportedEffort(spec, Effort.High)).toThrow(/not supported/);
	});

	it("drops authored thinking on non-reasoning models and treats empty efforts as undeclared", () => {
		const nonReasoning = createModel({
			id: "plain-model",
			api: "openai-responses",
			provider: "custom",
			baseUrl: "https://example.com",
			reasoning: false,
			thinking: { mode: "effort", efforts: [Effort.High] },
		});
		expect(nonReasoning.thinking).toBeUndefined();

		// Empty explicit efforts are absent metadata: no ladder is fabricated.
		const emptyEfforts = createModel({
			id: "gpt-5.2-codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			thinking: { mode: "effort", efforts: [] },
		});
		expect(emptyEfforts.thinking).toBeUndefined();
	});
});

/**
 * `ThinkingConfig.efforts` is contractually ordered least -> most intensive, and
 * the clamp helpers (`clampThinkingLevelForModel`, `minimumSupportedEffort`, and
 * the downstream auto clamp) walk the ladder in array order and break on the
 * first entry past the request. A hand-authored model spec can declare its
 * ladder out of order or with duplicates; identity defines no ladder for a
 * custom model id, so before the fix that raw array was baked verbatim and the
 * clamps picked the wrong effort. These pin the invariant that the build
 * canonicalizes any authored ladder, and that the clamps then resolve correctly.
 */
describe("canonicalizeEfforts", () => {
	it("reorders an out-of-order ladder into least -> most intensive", () => {
		// The declared set is preserved exactly; only the order changes.
		expect(canonicalizeEfforts([Effort.High, Effort.Low, Effort.Medium])).toEqual([
			Effort.Low,
			Effort.Medium,
			Effort.High,
		]);
		expect(canonicalizeEfforts([Effort.Max, Effort.Minimal])).toEqual([Effort.Minimal, Effort.Max]);
		expect(canonicalizeEfforts([Effort.XHigh, Effort.Low])).toEqual([Effort.Low, Effort.XHigh]);
	});

	it("drops duplicates while canonicalizing", () => {
		expect(canonicalizeEfforts([Effort.High, Effort.Low, Effort.High])).toEqual([Effort.Low, Effort.High]);
		expect(canonicalizeEfforts([Effort.Max, Effort.Max, Effort.Max])).toEqual([Effort.Max]);
	});

	it("leaves an already-canonical ladder unchanged and maps empty to empty", () => {
		expect(canonicalizeEfforts([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High])).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
		]);
		expect(canonicalizeEfforts([])).toEqual([]);
	});
});

describe("hand-authored effort ladders bake canonical", () => {
	// A custom model id: identity defines no ladder, so `resolveModelThinking`
	// falls back to the authored `thinking.efforts`. This is the only vector that
	// can carry an out-of-order ladder into a built model.
	function customModel(efforts: Effort[]): Model<"openai-completions"> {
		return createModel({
			id: "my-local-thinker",
			api: "openai-completions",
			provider: "custom",
			thinking: { mode: "effort", efforts },
		});
	}

	it("stores an out-of-order authored ladder in canonical order", () => {
		expect(customModel([Effort.High, Effort.Low, Effort.Medium]).thinking?.efforts).toEqual([
			Effort.Low,
			Effort.Medium,
			Effort.High,
		]);
		// A ladder identity would never infer (minimal + max only) proves the build,
		// not identity inference, is doing the canonicalization.
		expect(customModel([Effort.Max, Effort.Minimal]).thinking?.efforts).toEqual([Effort.Minimal, Effort.Max]);
	});

	it("clamps an unsupported request down to the nearest lower supported effort", () => {
		// Authored out of order as [High, Low]; a Medium request has no exact match
		// and must clamp down to Low, not up to High. Array-order iteration over the
		// raw [High, Low] would break on High immediately and return the wrong end.
		const model = customModel([Effort.High, Effort.Low]);
		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High]);
		expect(clampThinkingLevelForModel(model, Effort.Medium)).toBe(Effort.Low);
		expect(clampThinkingLevelForModel(model, Effort.Max)).toBe(Effort.High);
		expect(clampThinkingLevelForModel(model, Effort.Minimal)).toBe(Effort.Low);
	});

	it("reports the lowest supported effort regardless of authored order", () => {
		expect(minimumSupportedEffort(customModel([Effort.Max, Effort.Minimal]))).toBe(Effort.Minimal);
		expect(minimumSupportedEffort(customModel([Effort.High, Effort.Low, Effort.Medium]))).toBe(Effort.Low);
	});
});

describe("resolveReasoningSelection", () => {
	/**
	 * A selected effort, provider wire value, and effort-tier model SKU are one
	 * plan. Callers must not resolve those three facts independently.
	 */
	it("resolves effort maps and model-id routes together", () => {
		const model = createModel({
			id: "logical-thinker",
			api: "openai-completions",
			provider: "custom",
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.High],
				effortMap: { high: "max" },
				effortRouting: { low: "thinker-low", high: "thinker-high", off: "thinker-off" },
			},
		});

		expect(resolveReasoningSelection(model, { effort: Effort.High })).toEqual({
			state: "enabled",
			effort: Effort.High,
			wireEffort: "max",
			wireModelId: "thinker-high",
			mode: "effort",
			forcedByModel: false,
			enabled: true,
		});
		expect(resolveReasoningSelection(model, { disabled: true }).wireModelId).toBe("thinker-off");
	});

	/**
	 * Compatibility aliases describe accepted provider wire levels. The canonical
	 * plan must resolve unsupported user levels before any transport sees them.
	 */
	it("resolves compatibility effort aliases into supported canonical levels", () => {
		const model = createModel({
			id: "compat-thinker",
			api: "openai-completions",
			provider: "custom",
			compat: { reasoningEffortMap: { minimal: "low", xhigh: "high" } },
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
		});

		const minimal = resolveReasoningSelection(model, { effort: Effort.Minimal });
		const xhigh = resolveReasoningSelection(model, { effort: Effort.XHigh });

		expect(minimal.effort).toBe(Effort.Low);
		expect(minimal.wireEffort).toBe(Effort.Low);
		expect(xhigh.effort).toBe(Effort.High);
		expect(xhigh.wireEffort).toBe(Effort.High);
	});

	/**
	 * Explicit disable is stronger than a simultaneously supplied effort. This
	 * locks out providers accidentally enabling high reasoning from stale input.
	 */
	it("gives explicit disable precedence over effort", () => {
		const model = createModel({
			id: "disable-wins",
			api: "openai-completions",
			provider: "custom",
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
		});

		expect(resolveReasoningSelection(model, { effort: Effort.High, disabled: true })).toEqual({
			state: "disabled",
			effort: undefined,
			wireEffort: undefined,
			wireModelId: "disable-wins",
			mode: "effort",
			forcedByModel: false,
			enabled: false,
		});
	});

	/**
	 * Mandatory-reasoning endpoints cannot honor off. Their model capability
	 * must produce the lowest valid effort explicitly and reproducibly.
	 */
	it("floors disabled intent only when the model requires effort", () => {
		const model = createModel({
			id: "mandatory-thinker",
			api: "openai-completions",
			provider: "custom",
			thinking: {
				mode: "effort",
				efforts: [Effort.Medium, Effort.High],
				requiresEffort: true,
			},
		});

		expect(resolveReasoningSelection(model, { disabled: true })).toEqual({
			state: "enabled",
			effort: Effort.Medium,
			wireEffort: Effort.Medium,
			wireModelId: "mandatory-thinker",
			mode: "effort",
			forcedByModel: true,
			enabled: true,
		});
	});

	/**
	 * Reasoning capability and controllable effort are different facts. Native
	 * reasoning models without a dial must not invent a user-facing effort.
	 */
	it("distinguishes uncontrolled reasoning from unsupported reasoning", () => {
		const uncontrolled = createModel({
			id: "native-reasoner",
			api: "openai-responses",
			provider: "custom",
			compat: { supportsReasoningEffort: false },
		});
		const unsupported = createModel({
			id: "plain-model",
			api: "openai-completions",
			provider: "custom",
			reasoning: false,
		});

		expect(resolveReasoningSelection(uncontrolled, { effort: Effort.High }).state).toBe("uncontrolled");
		expect(resolveReasoningSelection(unsupported, { effort: Effort.High }).state).toBe("unsupported");
	});
});
