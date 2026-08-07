import { describe, expect, it } from "bun:test";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import { getSupportedEfforts } from "@veyyon/catalog/model-thinking";
import {
	MODELSDEV_REASONING_OPTION_TYPES,
	mapModelsDevReasoningOptions,
} from "@veyyon/catalog/provider-models/openai-compat";
import type { Api, Model, ModelSpec, Provider, ThinkingControlMode } from "@veyyon/catalog/types";
import { THINKING_CONTROL_MODES } from "@veyyon/catalog/types";

const EFFORT_ORDER: readonly Effort[] = [
	Effort.Minimal,
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
	Effort.Max,
];

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
		// so no surface is offered.
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

	it("declares no levels for a budget_tokens range, and none for future tiers", () => {
		// `budget_tokens` publishes a token RANGE, not a list of levels. Reading
		// [high, max] out of it was a guess wearing a declaration's clothes, and
		// it outranked every real declaration: a row in budget mode collapsed to
		// two rungs and an operator asking for `low` was served `high`. The
		// budget ladder is Veyyon's own (reasoning-budget.ts) and is applied
		// downstream, where it is visibly a local schedule.
		expect(mapModelsDevReasoningOptions([{ type: "budget_tokens", min: 0, max: 16384 }])).toBeUndefined();
		expect(mapModelsDevReasoningOptions([{ type: "budget_tokens" }, { type: "toggle" }])).toBeUndefined();
		expect(mapModelsDevReasoningOptions([{ type: "effort", values: ["ultra"] }])).toBeUndefined();
		expect(mapModelsDevReasoningOptions(undefined)).toBeUndefined();
	});
});

/**
 * A transport decides whether an UNDECLARED model may still be offered an effort
 * ladder. Get that wrong in either direction and the damage is silent: offer a
 * ladder nobody published and every request 400s, withhold one the endpoint
 * never validates and the operator's `low` resolves upward into a more
 * expensive tier. There is no way to read the answer off a transport's name, so
 * each one carries a decision recorded here.
 */
type TransportDecision =
	| { readonly surface: "closed" }
	| { readonly surface: "keeps-ladder"; readonly derivedMode: ThinkingControlMode }
	| { readonly surface: "conditional" };

interface TransportCase {
	readonly decision: TransportDecision;
	/**
	 * A spec that derives to THIS transport. Proven rather than asserted: the
	 * probe is built WITH a declaration, and a declared row keeps its inferred
	 * mode, so a representative that has drifted into another transport fails
	 * here instead of quietly making the decision below vacuous.
	 */
	readonly probe: { id: string; api: Api; provider: Provider };
	/** A second probe for a transport whose answer depends on the model. */
	readonly alternate?: { id: string; api: Api; provider: Provider; surface: "closed" | "keeps-ladder" };
}

const TRANSPORT_CASES = {
	// Sends `reasoning_effort` / `reasoning.effort`, a name the endpoint checks.
	effort: {
		decision: { surface: "closed" },
		probe: { id: "deepseek-v4-flash", api: "openai-completions", provider: "deepseek" },
	},
	// Sends a token count from Veyyon's own schedule. No name, nothing to reject.
	budget: {
		decision: { surface: "keeps-ladder", derivedMode: "budget" },
		probe: { id: "claude-sonnet-4-5", api: "anthropic-messages", provider: "anthropic" },
	},
	// Sends Google's published `thinkingLevel` enum. No catalogue covers Cloud
	// Code Assist, so a declaration will never arrive for this transport.
	"google-level": {
		decision: { surface: "keeps-ladder", derivedMode: "google-level" },
		probe: { id: "gemini-3.1-pro-preview", api: "google-gemini-cli", provider: "google-gemini-cli" },
	},
	// Sends `output_config.effort` ALONGSIDE a budget. Undeclared, the enum is
	// dropped (guessing it is #3497's HTTP 400) and the budget dial survives, so
	// the row degrades to a different transport rather than going dark.
	"anthropic-budget-effort": {
		decision: { surface: "keeps-ladder", derivedMode: "budget" },
		probe: { id: "claude-opus-4-5", api: "anthropic-messages", provider: "anthropic" },
	},
	// Sends an effort name, EXCEPT on MiniMax where every tier collapses to the
	// single literal `adaptive`. The transport alone does not settle it.
	"anthropic-adaptive": {
		decision: { surface: "conditional" },
		probe: { id: "MiniMax-M3", api: "anthropic-messages", provider: "minimax" },
		alternate: { id: "claude-mythos-5", api: "anthropic-messages", provider: "anthropic", surface: "closed" },
	},
} satisfies Record<ThinkingControlMode, TransportCase>;

describe("every thinking transport records what an undeclared model gets", () => {
	// `satisfies` above closes the class at typecheck; this closes it in the
	// suite, so a sixth transport is RED here and not merely a type error
	// somebody runs later.
	it("covers the whole transport union with no member left undecided", () => {
		expect(Object.keys(TRANSPORT_CASES).toSorted()).toEqual([...THINKING_CONTROL_MODES].toSorted());
	});

	it.each([...THINKING_CONTROL_MODES])("honors the recorded decision for %s", mode => {
		const entry: TransportCase = TRANSPORT_CASES[mode];

		// The probe really is this transport: a declared row keeps its inferred
		// mode, so this fails loudly if the fixture drifted.
		const declared = createModel({ ...entry.probe, reasoningOptions: { efforts: [Effort.High] } });
		expect(declared.thinking?.mode).toBe(mode);
		expect(getSupportedEfforts(declared)).toEqual([Effort.High]);

		const undeclared = createModel(entry.probe);
		if (entry.decision.surface === "closed") {
			expect(undeclared.thinking).toBeUndefined();
			expect(getSupportedEfforts(undeclared)).toEqual([]);
			return;
		}
		if (entry.decision.surface === "keeps-ladder") {
			expect(undeclared.thinking?.mode).toBe(entry.decision.derivedMode);
			expect(getSupportedEfforts(undeclared).length).toBeGreaterThan(0);
			return;
		}
		// Conditional: the transport says nothing on its own, so BOTH sides of
		// the condition are pinned. One-sided coverage here is how the MiniMax
		// dial was lost while every Anthropic row looked fine.
		expect(getSupportedEfforts(undeclared).length).toBeGreaterThan(0);
		const alternate = entry.alternate;
		if (!alternate) throw new Error(`conditional transport ${mode} must record an alternate probe`);
		const other = createModel(alternate);
		expect(other.thinking).toBeUndefined();
	});

	it("never offers an effort the model does not list, on any transport", () => {
		// The invariant at the choke point, rather than one transport's ladder:
		// whatever a row ends up offering, every tier is inside its own declared
		// or computed set, and asking outside it is refused rather than clamped.
		for (const mode of THINKING_CONTROL_MODES) {
			const model = createModel(TRANSPORT_CASES[mode].probe);
			const offered = getSupportedEfforts(model);
			expect(offered).toEqual([...new Set(offered)]);
			expect(offered).toEqual([...offered].toSorted((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b)));
			for (const effort of offered) {
				expect(model.thinking?.efforts).toContain(effort);
			}
		}
	});
});

describe("every models.dev reasoning-option type records an outcome", () => {
	const OPTION_OUTCOMES = {
		// Names the accepted levels. The only type that can open a ladder.
		effort: { opensLadder: true },
		// A token RANGE, not a level list. Declares nothing about levels.
		budget_tokens: { opensLadder: false },
		// Binary on/off. Reasons, no addressable effort.
		toggle: { opensLadder: false },
	} satisfies Record<(typeof MODELSDEV_REASONING_OPTION_TYPES)[number], { opensLadder: boolean }>;

	it("covers every recognized option type", () => {
		expect(Object.keys(OPTION_OUTCOMES).toSorted()).toEqual([...MODELSDEV_REASONING_OPTION_TYPES].toSorted());
	});

	it.each([...MODELSDEV_REASONING_OPTION_TYPES])("maps a bare %s declaration to its recorded outcome", type => {
		const mapped = mapModelsDevReasoningOptions([{ type, values: ["high"], min: 0, max: 16384 }]);
		if (OPTION_OUTCOMES[type].opensLadder) {
			expect(mapped).toEqual({ efforts: [Effort.High] });
			return;
		}
		// A `values` list is present and deliberately ignored: only `effort`
		// carries levels, so no other type may read one out of the payload.
		expect(mapped?.efforts).toBeUndefined();
	});

	it("keeps an unrecognized option type closed rather than guessing", () => {
		// models.dev is external and can add a type at any time. An unknown
		// declaration must never open a ladder; it means "reasons, no dial".
		expect(mapModelsDevReasoningOptions([{ type: "thinking_level_2027", values: ["low", "high"] }])).toEqual({
			noEffortControl: true,
		});
	});
});

describe("transports whose control Veyyon computes keep a ladder undeclared", () => {
	// The declared-surface rule exists because an invented effort NAME earns a
	// 400 from the endpoint. These three transports send no name, so applying
	// the rule to them takes away a working dial and silently resolves an
	// operator's `low` upward into whatever tier survives.
	it("gives an undeclared Anthropic budget row the full local token schedule", () => {
		// The wire carries `thinking.budget_tokens`, a number from Veyyon's own
		// per-effort schedule. Anthropic's schedule gives xhigh its own 32k.
		const model = createModel({ id: "claude-sonnet-4-5", api: "anthropic-messages", provider: "anthropic" });
		expect(model.thinking?.mode).toBe("budget");
		expect(getSupportedEfforts(model)).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
		]);
	});

	it("stops an undeclared Google budget row at high, where its schedule stops", () => {
		const model = createModel({ id: "gemini-2.5-flash", api: "google-generative-ai", provider: "google" });
		expect(model.thinking?.mode).toBe("budget");
		expect(getSupportedEfforts(model)).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High]);
	});

	it("keeps Google's published thinkingLevel enum per family on Cloud Code Assist", () => {
		// No catalogue covers Cloud Code Assist, so a declaration will never
		// arrive for the first-party Gemini CLI transport. Google publishes the
		// enum itself: LOW/HIGH for 3.x Pro, MINIMAL..HIGH for the Flash line.
		const pro = createModel({
			id: "gemini-3.1-pro-preview",
			api: "google-gemini-cli",
			provider: "google-gemini-cli",
		});
		expect(pro.thinking?.mode).toBe("google-level");
		expect(getSupportedEfforts(pro)).toEqual([Effort.Low, Effort.High]);

		const flash = createModel({ id: "gemini-3.1-flash", api: "google-gemini-cli", provider: "google-gemini-cli" });
		expect(getSupportedEfforts(flash)).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High]);
	});

	it("keeps the MiniMax adaptive dial, whose every tier is the same wire literal", () => {
		// MiniMax on the Anthropic endpoint collapses each tier to the literal
		// `adaptive`, so no name reaches the endpoint and there is nothing to
		// reject. Every other adaptive row does send a name and stays closed.
		const minimax = createModel({ id: "MiniMax-M3", api: "anthropic-messages", provider: "minimax" });
		expect(getSupportedEfforts(minimax)).toEqual([Effort.Low, Effort.Medium, Effort.High]);
		expect(minimax.thinking?.effortMap).toEqual({ low: "adaptive", medium: "adaptive", high: "adaptive" });

		const claude = createModel({ id: "claude-mythos-5", api: "anthropic-messages", provider: "anthropic" });
		expect(claude.thinking?.mode).not.toBe("anthropic-adaptive");
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

	it("lets a discovery-declared pair replace the budget transport's own ladder", () => {
		// Budget transports supply a local ladder when nothing is declared, so
		// this pins the precedence: a declaration still wins over it, and the row
		// offers the two tiers discovery named rather than the full schedule.
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
