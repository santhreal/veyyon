import { describe, expect, it } from "bun:test";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import { getSupportedEfforts } from "@veyyon/catalog/model-thinking";
import { mapModelsDevReasoningOptions } from "@veyyon/catalog/provider-models/openai-compat";
import type { Api, Model, ModelSpec, Provider } from "@veyyon/catalog/types";

function createModel<TApi extends Api>(overrides: {
	id: string;
	api: TApi;
	provider: Provider;
	reasoning?: boolean;
	baseUrl?: string;
	thinking?: ModelSpec<TApi>["thinking"];
	reasoningOptions?: ModelSpec<TApi>["reasoningOptions"];
}): Model<TApi> {
	return buildModel({
		id: overrides.id,
		name: overrides.id,
		api: overrides.api,
		provider: overrides.provider,
		baseUrl: overrides.baseUrl ?? "",
		reasoning: overrides.reasoning ?? true,
		thinking: overrides.thinking,
		reasoningOptions: overrides.reasoningOptions,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	});
}

describe("mapModelsDevReasoningOptions", () => {
	it("maps an effort declaration to the ladder, dropping the off sentinel", () => {
		expect(
			mapModelsDevReasoningOptions([{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }]),
		).toEqual({ efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] });
		expect(mapModelsDevReasoningOptions([{ type: "effort", values: [null, "high", "max"] }])).toEqual({
			efforts: [Effort.High, Effort.Max],
		});
	});

	it("treats an empty list or a toggle-only surface as reasoning with no effort control", () => {
		expect(mapModelsDevReasoningOptions([])).toEqual({ noEffortControl: true });
		expect(mapModelsDevReasoningOptions([{ type: "toggle" }])).toEqual({ noEffortControl: true });
	});

	/**
	 * An `effort` option that declares no level at all is the toggle surface
	 * spelled through the effort field, not a future tier: `cerebras/zai-glm-4.7`
	 * declares `["none"]` and `groq/qwen/qwen3.6-27b` declares
	 * `["none","default"]`. Falling back to identity there fabricated a four- and
	 * a five-level ladder the endpoint says it does not accept.
	 */
	it("treats an effort declaration carrying no level as no effort control", () => {
		expect(mapModelsDevReasoningOptions([{ type: "effort", values: ["none"] }])).toEqual({
			noEffortControl: true,
		});
		expect(mapModelsDevReasoningOptions([{ type: "effort", values: ["none", "default"] }])).toEqual({
			noEffortControl: true,
		});
		expect(mapModelsDevReasoningOptions([{ type: "effort", values: [null] }])).toEqual({
			noEffortControl: true,
		});
		expect(mapModelsDevReasoningOptions([{ type: "effort", values: [] }])).toEqual({
			noEffortControl: true,
		});
		// An `effort` option with no `values` key declares nothing about levels,
		// which is the identity-fallback case and stays one.
		expect(mapModelsDevReasoningOptions([{ type: "effort" }])).toBeUndefined();
	});

	/**
	 * The end state a level-less declaration must reach: no thinking config, so
	 * every effort surface reports the row as uncontrollable rather than offering
	 * levels the endpoint rejects.
	 */
	it("leaves a level-less declared row with no controllable effort", () => {
		const model = createModel({
			id: "zai-glm-4.7",
			api: "openai-completions",
			provider: "cerebras",
			reasoning: true,
			reasoningOptions: mapModelsDevReasoningOptions([{ type: "effort", values: ["none"] }]),
		});
		expect(getSupportedEfforts(model)).toEqual([]);
		expect(model.thinking).toBeUndefined();
	});

	it("pins a single-effort SKU whose id ends in that effort, and only then", () => {
		expect(mapModelsDevReasoningOptions([{ type: "effort", values: ["high"] }], "openai/o4-mini-high")).toEqual({
			noEffortControl: true,
		});
		// Same declaration on an id that does not bake the tier stays a choice.
		expect(mapModelsDevReasoningOptions([{ type: "effort", values: ["high"] }], "mistral-medium-3-5")).toEqual({
			efforts: [Effort.High],
		});
		expect(mapModelsDevReasoningOptions([{ type: "effort", values: ["low", "high"] }], "o4-mini-high")).toEqual({
			efforts: [Effort.Low, Effort.High],
		});
	});

	it("opens the fixed high/max budget pair for budget-only declarations, nothing for future tiers", () => {
		// opencode's budgetVariants contract: a budget_tokens declaration with
		// no effort levels maps to the fixed high/max pair the encoder ranges.
		expect(mapModelsDevReasoningOptions([{ type: "budget_tokens", min: 0, max: 16384 }])).toEqual({
			efforts: [Effort.High, Effort.Max],
		});
		expect(mapModelsDevReasoningOptions([{ type: "budget_tokens" }, { type: "toggle" }])).toEqual({
			efforts: [Effort.High, Effort.Max],
		});
		expect(mapModelsDevReasoningOptions([{ type: "effort", values: ["ultra"] }])).toBeUndefined();
		expect(mapModelsDevReasoningOptions(undefined)).toBeUndefined();
	});
});

describe("discovery-declared reasoning surfaces", () => {
	it("lets the declared ladder win over the identity-derived one (OpenRouter GLM-5.2)", () => {
		// Identity would derive the full minimal..xhigh ladder for an OpenRouter
		// GLM-5.2 row; models.dev declares the endpoint accepts only high/xhigh.
		const model = createModel({
			id: "z-ai/glm-5.2",
			api: "openrouter",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoningOptions: { efforts: [Effort.High, Effort.XHigh] },
		});
		expect(getSupportedEfforts(model)).toEqual([Effort.High, Effort.XHigh]);
	});

	it("pins an id-baked SKU to the single declared effort (openai/o4-mini-high)", () => {
		const model = createModel({
			id: "openai/o4-mini-high",
			api: "openrouter",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoningOptions: { efforts: [Effort.High] },
		});
		expect(getSupportedEfforts(model)).toEqual([Effort.High]);
	});

	it("exposes no effort control on a toggle-only or always-thinks row", () => {
		const model = createModel({
			id: "moonshotai/kimi-k2-thinking",
			api: "openrouter",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoningOptions: { noEffortControl: true },
		});
		expect(model.reasoning).toBe(true);
		expect(model.thinking).toBeUndefined();
		expect(getSupportedEfforts(model)).toEqual([]);
	});

	it("opens the high/max budget surface when discovery declares a budget range only", () => {
		// models.dev budget-only declarations normalize to the fixed high/max
		// pair (opencode parity); no ladder is identity-derived.
		const model = createModel({
			id: "gemini-3.1-pro-preview",
			api: "google-generative-ai",
			provider: "google",
			reasoningOptions: { efforts: [Effort.High, Effort.Max] },
		});
		expect(getSupportedEfforts(model)).toEqual([Effort.High, Effort.Max]);
	});

	it("never overrides a collapsed row's routed surface with discovery data", () => {
		const model = createModel({
			id: "gpt-5.4",
			api: "cursor-agent",
			provider: "cursor",
			reasoningOptions: { efforts: [Effort.High] },
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				requiresEffort: true,
				effortRouting: {
					[Effort.Low]: "gpt-5.4-low",
					[Effort.Medium]: "gpt-5.4-medium",
					[Effort.High]: "gpt-5.4-high",
					[Effort.XHigh]: "gpt-5.4-xhigh",
				},
			},
		});
		expect(model.thinking?.effortRouting?.[Effort.XHigh]).toBe("gpt-5.4-xhigh");
		expect(getSupportedEfforts(model)).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
	});

	it("ignores discovery data on non-reasoning rows", () => {
		const model = createModel({
			id: "gpt-image-2",
			api: "openai-completions",
			provider: "openai",
			reasoning: false,
			reasoningOptions: { efforts: [Effort.High] },
		});
		expect(model.thinking).toBeUndefined();
	});
});

describe("cursor-agent rows expose no unfabricated effort control", () => {
	it("gives an uncollapsed cursor reasoning row no thinking surface", () => {
		// Cursor's transport has no effort field: effort exists only as
		// tier-suffixed sibling ids, so an uncollapsed row must not offer a
		// ladder its wire cannot honor (gpt-5.1-codex-max-high shipped one).
		const model = createModel({
			id: "gpt-5.1-codex-max-high",
			api: "cursor-agent",
			provider: "cursor",
		});
		expect(model.reasoning).toBe(true);
		expect(model.thinking).toBeUndefined();
		expect(getSupportedEfforts(model)).toEqual([]);
	});

	it("keeps a collapsed cursor row's explicit routed surface", () => {
		const model = createModel({
			id: "gpt-5.3-codex",
			api: "cursor-agent",
			provider: "cursor",
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.High, Effort.XHigh],
				effortRouting: {
					[Effort.Low]: "gpt-5.3-codex-low",
					[Effort.High]: "gpt-5.3-codex-high",
					[Effort.XHigh]: "gpt-5.3-codex-xhigh",
				},
			},
		});
		expect(model.thinking?.effortRouting?.[Effort.High]).toBe("gpt-5.3-codex-high");
		expect(getSupportedEfforts(model)).toEqual([Effort.Low, Effort.High, Effort.XHigh]);
	});
});
