/**
 * WHY. A per-provider capability used to be written where it was needed, as
 * `provider === "x" || provider === "y"`, so the service-tier behavior of one
 * provider was spread across four functions and no list stated what it decided.
 * The defect that shape produces is fail-open: a provider added to the catalog
 * inherits whatever each unrelated `else` branch happens to say, and nobody is
 * asked. The declarations now live in one table
 * (`src/provider-models/wire-capabilities.ts`) and this suite closes the class:
 * it enumerates the catalog at run time, so a new provider turns the suite RED
 * until someone records a decision for it, and it pins what each declared
 * provider realizes so the migration cannot drift.
 *
 * WHAT IT DOES NOT CATCH. Nothing here proves a provider's declaration matches
 * the vendor's documented behavior — that is a claim about an endpoint, not
 * about this tree. It also does not stop a caller from writing a fresh
 * `provider === "x"` comparison somewhere new; only review does.
 */
import { describe, expect, it } from "bun:test";
import { CATALOG_PROVIDERS } from "../src/provider-models/descriptors";
import {
	getPriorityPremiumRequests,
	providersDeclaringServiceTier,
	providerWireCapabilities,
	realizesPriorityServiceTier,
	resolveModelServiceTier,
	SERVICE_TIERS,
	type ServiceTier,
	serviceTierFamily,
	shouldSendServiceTier,
} from "../src/provider-models/wire-capabilities";
import type { Api, Model } from "../src/types";

const catalogProviderIds = CATALOG_PROVIDERS.map(entry => entry.id as string);

function model(provider: string, id: string, api: Api): Pick<Model, "provider" | "api" | "id"> {
	return { provider, id, api };
}

/**
 * Every catalog provider that declares NO service-tier capability, pinned by
 * exact equality. A provider added to the catalog lands here and reds the
 * assertion below, which is the point: the decision is recorded, not defaulted.
 */
const NO_SERVICE_TIER_KNOB = [
	"aimlapi",
	"alibaba-coding-plan",
	"amazon-bedrock",
	"azure",
	"baseten",
	"cerebras",
	"cloudflare-ai-gateway",
	"coreweave",
	"cursor",
	"deepseek",
	"devin",
	"firepass",
	"github-copilot",
	"gitlab-duo",
	"gitlab-duo-agent",
	"google-antigravity",
	"google-gemini-cli",
	"groq",
	"huggingface",
	"kilo",
	"kimi-code",
	"litellm",
	"lm-studio",
	"minimax",
	"minimax-code",
	"minimax-code-cn",
	"mistral",
	"moonshot",
	"nanogpt",
	"novita",
	"nvidia",
	"ollama",
	"ollama-cloud",
	"opencode-go",
	"opencode-zen",
	"qianfan",
	"qwen-portal",
	"sakana",
	"synthetic",
	"together",
	"umans",
	"venice",
	"vercel-ai-gateway",
	"vllm",
	"wafer-serverless",
	"xai",
	"xai-oauth",
	"xiaomi",
	"xiaomi-token-plan-ams",
	"xiaomi-token-plan-cn",
	"xiaomi-token-plan-sgp",
	"zai",
	"zenmux",
	"zhipu-coding-plan",
] as const;

describe("the provider table decides what a provider realizes on the wire", () => {
	// NON-VACUITY: the sweep really reads the catalog, so an empty enumeration cannot pass the rest.
	it("enumerates the catalog table at run time", () => {
		expect(catalogProviderIds.length).toBeGreaterThan(40);
		expect(catalogProviderIds).toContain("openai");
	});

	it("answers the service-tier question from a declaration or from nothing, never from a default", () => {
		const undeclared = catalogProviderIds
			.filter(id => providerWireCapabilities(id)?.serviceTier === undefined)
			.sort();
		expect(undeclared).toEqual([...NO_SERVICE_TIER_KNOB].sort());
	});

	it("declares a tier knob for exactly the providers that have one", () => {
		expect([...providersDeclaringServiceTier()].sort()).toEqual([
			"anthropic",
			"fireworks",
			"google",
			"google-vertex",
			"openai",
			"openai-codex",
			"openrouter",
		]);
	});

	it("declares only tiers that exist, and premium billing only where priority is realized", () => {
		for (const id of providersDeclaringServiceTier()) {
			const capability = providerWireCapabilities(id)?.serviceTier;
			expect(capability).toBeDefined();
			if (!capability) continue;
			for (const tier of capability.wireTiers) {
				expect(SERVICE_TIERS as readonly string[]).toContain(tier);
			}
			const realizesPriority =
				capability.wireTiers.includes("priority") ||
				capability.realizesPriorityOffWire === true ||
				(capability.realizesPriorityForFamilies?.length ?? 0) > 0;
			if (capability.premiumPriority) expect(realizesPriority).toBe(true);
			// A family-scoped realization list is only meaningful for a gateway classified by model id.
			if (capability.realizesPriorityForFamilies) expect(capability.family).toBe("model-namespace");
		}
	});
});

describe("what each declared provider realizes", () => {
	const cases: ReadonlyArray<
		readonly [
			label: string,
			target: Pick<Model, "provider" | "api" | "id">,
			family: string | undefined,
			sendsPriority: boolean,
			realizesPriority: boolean,
			premium: number,
		]
	> = [
		["openai", model("openai", "gpt-5.5", "openai-responses"), "openai", true, true, 1],
		["openai-codex", model("openai-codex", "gpt-5.5-codex", "openai-codex-responses"), "openai", true, true, 1],
		["anthropic fast mode", model("anthropic", "claude-opus-4-8", "anthropic-messages"), "anthropic", false, true, 1],
		["google", model("google", "gemini-3.5-pro", "google-generative-ai"), "google", true, true, 1],
		["google-vertex", model("google-vertex", "gemini-3.5-pro", "google-generative-ai"), "google", true, true, 1],
		[
			"vertex claude follows the anthropic knob and drops priority",
			model("google-vertex", "claude-opus-4-8", "anthropic-messages"),
			"anthropic",
			true,
			false,
			0,
		],
		[
			"bedrock claude follows the anthropic knob and drops priority",
			model("amazon-bedrock", "us.anthropic.claude-opus-4-8", "anthropic-messages"),
			"anthropic",
			false,
			false,
			0,
		],
		[
			"fireworks owns its serving control, so no family knob reaches it",
			model("fireworks", "accounts/fireworks/models/kimi-k2", "openai-completions"),
			undefined,
			true,
			true,
			0,
		],
		[
			"an openai model id on fireworks stays out of the openai family",
			model("fireworks", "gpt-5.5", "openai-completions"),
			undefined,
			true,
			true,
			0,
		],
		[
			"an openrouter openai upstream",
			model("openrouter", "openai/gpt-5.5", "openai-completions"),
			"openai",
			true,
			true,
			0,
		],
		[
			"an openrouter anthropic upstream does not realize priority",
			model("openrouter", "anthropic/claude-opus-4-8", "openai-completions"),
			"anthropic",
			true,
			false,
			0,
		],
		[
			// The tier is still sent — OpenRouter accepts the field for every model it fronts — and
			// realizes nothing, because no upstream family owns the id.
			"an openrouter upstream with no vendor prefix has no family",
			model("openrouter", "qwen3.7-plus", "openai-completions"),
			undefined,
			true,
			false,
			0,
		],
		[
			"a relay serving an openai model id is the openai family and bills nothing",
			model("litellm", "gpt-5.5", "openai-completions"),
			"openai",
			true,
			true,
			0,
		],
		[
			"a relay serving its own model id has no family",
			model("litellm", "qwen3.7-plus", "openai-completions"),
			undefined,
			false,
			false,
			0,
		],
	];

	it.each(cases)("%s", (_label, target, family, sendsPriority, realizesPriority, premium) => {
		expect(serviceTierFamily(target)).toBe(family as never);
		expect(shouldSendServiceTier("priority", target)).toBe(sendsPriority);
		expect(realizesPriorityServiceTier("priority", target)).toBe(realizesPriority);
		expect(getPriorityPremiumRequests("priority", target)).toBe(premium);
	});

	it("sends only the tiers a provider declares", () => {
		const flexAndScale: readonly ServiceTier[] = ["flex", "scale"];
		const openai = model("openai", "gpt-5.5", "openai-responses");
		const google = model("google", "gemini-3.5-pro", "google-generative-ai");
		const vertex = model("google-vertex", "gemini-3.5-pro", "google-generative-ai");
		expect(flexAndScale.map(tier => shouldSendServiceTier(tier, openai))).toEqual([true, true]);
		// Gemini takes flex; Vertex documents no flex control, so it takes neither.
		expect(flexAndScale.map(tier => shouldSendServiceTier(tier, google))).toEqual([true, false]);
		expect(flexAndScale.map(tier => shouldSendServiceTier(tier, vertex))).toEqual([false, false]);
		// A tier the user never set is never sent, whatever the provider declares.
		expect(shouldSendServiceTier(undefined, openai)).toBe(false);
	});

	it("accepts a bare provider id as the target, for a request that has no model in hand", () => {
		expect(shouldSendServiceTier("priority", "openai")).toBe(true);
		expect(shouldSendServiceTier("flex", "google-vertex")).toBe(false);
		// A bare id cannot reach the relay rule: that answer needs the model's own id.
		expect(shouldSendServiceTier("priority", "litellm")).toBe(false);
		expect(shouldSendServiceTier("priority", undefined)).toBe(false);
	});

	it("reads the family's own entry out of a per-family map", () => {
		const tiers = { openai: "flex", anthropic: "priority" } as const;
		expect(resolveModelServiceTier(tiers, model("openai", "gpt-5.5", "openai-responses"))).toBe("flex");
		expect(resolveModelServiceTier(tiers, model("anthropic", "claude-opus-4-8", "anthropic-messages"))).toBe(
			"priority",
		);
		// Declared google knob, no google entry in the map.
		expect(resolveModelServiceTier(tiers, model("google", "gemini-3.5-pro", "google-generative-ai"))).toBeUndefined();
		// No family at all: the map cannot reach it.
		expect(resolveModelServiceTier(tiers, model("litellm", "qwen3.7-plus", "openai-completions"))).toBeUndefined();
		expect(resolveModelServiceTier(undefined, model("openai", "gpt-5.5", "openai-responses"))).toBeUndefined();
	});
});
