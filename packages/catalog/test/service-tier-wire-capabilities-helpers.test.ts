import { describe, expect, it } from "bun:test";
import {
	getPriorityPremiumRequests,
	realizesPriorityServiceTier,
	resolveModelServiceTier,
	serviceTierFamily,
	shouldSendServiceTier,
} from "../src/provider-models/service-tier";
import {
	coerceServiceTierByFamily,
	declaredCapabilityNames,
	declaredProviders,
	isServiceTier,
	OPENAI_WIRE_TIERS,
	providersDeclaring,
	providerWireCapabilities,
	SERVICE_TIERS,
	type ServiceTier,
	type ServiceTierByFamily,
} from "../src/provider-models/wire-capabilities";
import type { Api, Model } from "../src/types";

function model(provider: string, api: Api | undefined, id: string): Pick<Model, "provider" | "api" | "id"> {
	return { provider, api, id };
}

describe("isServiceTier", () => {
	it("returns true for all SERVICE_TIERS", () => {
		for (const tier of SERVICE_TIERS) expect(isServiceTier(tier)).toBe(true);
	});
	it("returns false for non-tier strings", () => {
		expect(isServiceTier("priority-plus")).toBe(false);
		expect(isServiceTier("")).toBe(false);
	});
	it("returns false for non-strings", () => {
		expect(isServiceTier(42)).toBe(false);
		expect(isServiceTier(null)).toBe(false);
		expect(isServiceTier(undefined)).toBe(false);
		expect(isServiceTier({})).toBe(false);
	});
});

describe("SERVICE_TIERS", () => {
	it("contains auto, default, flex, scale, priority", () => {
		expect(SERVICE_TIERS).toEqual(["auto", "default", "flex", "scale", "priority"]);
	});
});

describe("OPENAI_WIRE_TIERS", () => {
	it("contains flex, scale, priority", () => {
		expect(OPENAI_WIRE_TIERS).toEqual(["flex", "scale", "priority"]);
	});
});

describe("providerWireCapabilities", () => {
	it("returns undefined for undefined", () => {
		expect(providerWireCapabilities(undefined)).toBeUndefined();
	});
	it("returns undefined for unknown provider", () => {
		expect(providerWireCapabilities("nonexistent")).toBeUndefined();
	});
	it("returns capabilities for anthropic", () => {
		const cap = providerWireCapabilities("anthropic");
		expect(cap).toBeDefined();
		expect(cap?.anthropicMessages?.directEndpoint).toBe(true);
	});
	it("returns capabilities for openai", () => {
		const cap = providerWireCapabilities("openai");
		expect(cap?.serviceTier?.family).toBe("openai");
		expect(cap?.strictTools).toBe(true);
	});
	it("returns localInference for ollama", () => {
		expect(providerWireCapabilities("ollama")?.localInference).toBe(true);
	});
	it("returns localInference for llama.cpp", () => {
		expect(providerWireCapabilities("llama.cpp")?.localInference).toBe(true);
	});
	it("returns localInference for lm-studio", () => {
		expect(providerWireCapabilities("lm-studio")?.localInference).toBe(true);
	});
	it("returns localInference for vllm", () => {
		expect(providerWireCapabilities("vllm")?.localInference).toBe(true);
	});
	it("returns strictTools for cerebras", () => {
		expect(providerWireCapabilities("cerebras")?.strictTools).toBe(true);
	});
	it("returns strictTools for together", () => {
		expect(providerWireCapabilities("together")?.strictTools).toBe(true);
	});
	it("returns strictTools for zenmux", () => {
		expect(providerWireCapabilities("zenmux")?.strictTools).toBe(true);
	});
	it("returns forwardsUpstream for litellm", () => {
		expect(providerWireCapabilities("litellm")?.forwardsUpstream).toBe(true);
	});
	it("returns gateway-managed for cloudflare-ai-gateway", () => {
		expect(providerWireCapabilities("cloudflare-ai-gateway")?.anthropicMessages?.credential).toBe("gateway-managed");
	});
	it("returns copilot-bearer for github-copilot", () => {
		expect(providerWireCapabilities("github-copilot")?.anthropicMessages?.credential).toBe("copilot-bearer");
	});
	it("github-copilot rejects betas and context management", () => {
		const cap = providerWireCapabilities("github-copilot")?.anthropicMessages;
		expect(cap?.rejectsBetas).toBe(true);
		expect(cap?.rejectsContextManagement).toBe(true);
	});
});

describe("providersDeclaring", () => {
	it("returns providers with serviceTier", () => {
		const providers = providersDeclaring("serviceTier");
		expect(providers).toContain("anthropic");
		expect(providers).toContain("openai");
		expect(providers).toContain("google");
	});
	it("returns providers with strictTools", () => {
		const providers = providersDeclaring("strictTools");
		expect(providers).toContain("openai");
		expect(providers).toContain("cerebras");
		expect(providers).toContain("together");
	});
	it("returns providers with localInference", () => {
		const providers = providersDeclaring("localInference");
		expect(providers).toContain("ollama");
		expect(providers).toContain("vllm");
	});
	it("does not include providers without the capability", () => {
		const strictTools = providersDeclaring("strictTools");
		expect(strictTools).not.toContain("anthropic");
		expect(strictTools).not.toContain("ollama");
	});
});

describe("declaredProviders", () => {
	it("returns all providers in the capability table", () => {
		const providers = declaredProviders();
		expect(providers.length).toBeGreaterThan(10);
		expect(providers).toContain("anthropic");
		expect(providers).toContain("openai");
		expect(providers).toContain("ollama");
	});
	it("names are unique", () => {
		const providers = declaredProviders();
		expect(new Set(providers).size).toBe(providers.length);
	});
});

describe("declaredCapabilityNames", () => {
	it("returns sorted capability names", () => {
		const names = declaredCapabilityNames();
		expect(names).toContain("serviceTier");
		expect(names).toContain("strictTools");
		expect(names).toContain("localInference");
		expect(names).toContain("anthropicMessages");
		expect(names).toContain("forwardsUpstream");
	});
	it("names are sorted", () => {
		const names = declaredCapabilityNames();
		const sorted = [...names].sort();
		expect(names).toEqual(sorted);
	});
});

describe("coerceServiceTierByFamily", () => {
	it("returns undefined for null", () => {
		expect(coerceServiceTierByFamily(null)).toBeUndefined();
	});
	it("returns undefined for undefined", () => {
		expect(coerceServiceTierByFamily(undefined)).toBeUndefined();
	});
	it("returns undefined for non-object non-string", () => {
		expect(coerceServiceTierByFamily(42)).toBeUndefined();
	});
	it("returns undefined for empty object", () => {
		expect(coerceServiceTierByFamily({})).toBeUndefined();
	});
	it("returns undefined for object with no valid tiers", () => {
		expect(coerceServiceTierByFamily({ openai: "invalid" })).toBeUndefined();
	});
	it("coerces 'priority' string to all families", () => {
		expect(coerceServiceTierByFamily("priority")).toEqual({
			openai: "priority",
			anthropic: "priority",
			google: "priority",
		});
	});
	it("coerces 'openai-only' string to openai priority", () => {
		expect(coerceServiceTierByFamily("openai-only")).toEqual({ openai: "priority" });
	});
	it("coerces 'claude-only' string to anthropic priority", () => {
		expect(coerceServiceTierByFamily("claude-only")).toEqual({ anthropic: "priority" });
	});
	it("coerces bare tier string to openai family", () => {
		expect(coerceServiceTierByFamily("flex")).toEqual({ openai: "flex" });
	});
	it("returns undefined for unknown string", () => {
		expect(coerceServiceTierByFamily("unknown-tier")).toBeUndefined();
	});
	it("extracts valid tiers from object", () => {
		expect(coerceServiceTierByFamily({ openai: "flex", anthropic: "priority" })).toEqual({
			openai: "flex",
			anthropic: "priority",
		});
	});
	it("ignores invalid tier values in object", () => {
		expect(coerceServiceTierByFamily({ openai: "flex", anthropic: "invalid" })).toEqual({ openai: "flex" });
	});
	it("ignores unknown family keys in object", () => {
		expect(coerceServiceTierByFamily({ openai: "flex", unknown: "priority" })).toEqual({ openai: "flex" });
	});
});

describe("serviceTierFamily", () => {
	it("returns anthropic for anthropropic-messages api", () => {
		expect(serviceTierFamily(model("custom", "anthropic-messages", "claude-3"))).toBe("anthropic");
	});
	it("returns openai for openai completions api with openai model id", () => {
		expect(serviceTierFamily(model("custom", "openai-completions", "gpt-4"))).toBe("openai");
	});
	it("returns openai for openai responses api with openai model id", () => {
		expect(serviceTierFamily(model("custom", "openai-responses", "gpt-4o"))).toBe("openai");
	});
	it("returns openai for openai codex responses api with codex model id", () => {
		expect(serviceTierFamily(model("custom", "openai-codex-responses", "codex-1"))).toBe("openai");
	});
	it("returns undefined for unknown api and non-openai id", () => {
		expect(serviceTierFamily(model("custom", "google-genai", "gemini-1.5"))).toBeUndefined();
	});
	it("uses provider capability family when set", () => {
		expect(serviceTierFamily(model("anthropic", "anthropic-messages", "claude-3"))).toBe("anthropic");
	});
	it("uses model-namespace for openrouter", () => {
		expect(serviceTierFamily(model("openrouter", "openai-completions", "anthropic/claude-3"))).toBe("anthropic");
	});
	it("model-namespace resolves google/", () => {
		expect(serviceTierFamily(model("openrouter", "openai-completions", "google/gemini-1.5"))).toBe("google");
	});
	it("model-namespace resolves openai/", () => {
		expect(serviceTierFamily(model("openrouter", "openai-completions", "openai/gpt-4"))).toBe("openai");
	});
	it("model-namespace returns undefined for unknown namespace", () => {
		expect(serviceTierFamily(model("openrouter", "openai-completions", "mistral/mistral-7b"))).toBeUndefined();
	});
	it("google-vertex anthropicMessagesOverridesFamily returns anthropic for anthropic-messages", () => {
		expect(serviceTierFamily(model("google-vertex", "anthropic-messages", "claude-3"))).toBe("anthropic");
	});
	it("google returns google for non-anthropic api", () => {
		expect(serviceTierFamily(model("google", "google-genai", "gemini-1.5"))).toBe("google");
	});
});

describe("resolveModelServiceTier", () => {
	it("returns undefined for null tiers", () => {
		expect(resolveModelServiceTier(null, model("openai", "openai-completions", "gpt-4"))).toBeUndefined();
	});
	it("returns undefined for undefined tiers", () => {
		expect(resolveModelServiceTier(undefined, model("openai", "openai-completions", "gpt-4"))).toBeUndefined();
	});
	it("returns tier for matching family", () => {
		const tiers: ServiceTierByFamily = { openai: "priority" };
		expect(resolveModelServiceTier(tiers, model("openai", "openai-completions", "gpt-4"))).toBe("priority");
	});
	it("returns undefined when family not in tiers", () => {
		const tiers: ServiceTierByFamily = { anthropic: "priority" };
		expect(resolveModelServiceTier(tiers, model("openai", "openai-completions", "gpt-4"))).toBeUndefined();
	});
	it("returns undefined when model has no family", () => {
		const tiers: ServiceTierByFamily = { openai: "priority" };
		expect(resolveModelServiceTier(tiers, model("custom", "google-genai", "gemini-1.5"))).toBeUndefined();
	});
});

describe("shouldSendServiceTier", () => {
	it("returns false for null service tier", () => {
		expect(shouldSendServiceTier(null, "openai")).toBe(false);
	});
	it("returns false for undefined service tier", () => {
		expect(shouldSendServiceTier(undefined, "openai")).toBe(false);
	});
	it("returns true when tier is in provider wireTiers", () => {
		expect(shouldSendServiceTier("priority", "openai")).toBe(true);
	});
	it("returns false when tier not in provider wireTiers", () => {
		expect(shouldSendServiceTier("auto", "openai")).toBe(false);
	});
	it("returns false for provider without service tier capability", () => {
		expect(shouldSendServiceTier("priority", "ollama")).toBe(false);
	});
	it("returns true for openai relay model with OPENAI_WIRE_TIERS tier", () => {
		expect(shouldSendServiceTier("flex", model("custom", "openai-completions", "gpt-4"))).toBe(true);
	});
	it("returns false for openai relay model with non-wire tier", () => {
		expect(shouldSendServiceTier("auto", model("custom", "openai-completions", "gpt-4"))).toBe(false);
	});
	it("returns false for non-openai relay model without capability", () => {
		expect(shouldSendServiceTier("priority", model("custom", "google-genai", "gemini-1.5"))).toBe(false);
	});
	it("anthropic has empty wireTiers so no tier is sent", () => {
		expect(shouldSendServiceTier("priority", "anthropic")).toBe(false);
	});
	it("fireworks sends priority", () => {
		expect(shouldSendServiceTier("priority", "fireworks")).toBe(true);
	});
	it("fireworks does not send flex", () => {
		expect(shouldSendServiceTier("flex", "fireworks")).toBe(false);
	});
});

describe("realizesPriorityServiceTier", () => {
	it("returns false for non-priority tier", () => {
		expect(realizesPriorityServiceTier("flex", model("openai", "openai-completions", "gpt-4"))).toBe(false);
	});
	it("returns false for null", () => {
		expect(realizesPriorityServiceTier(null, model("openai", "openai-completions", "gpt-4"))).toBe(false);
	});
	it("returns true for anthropic (realizesPriorityOffWire)", () => {
		expect(realizesPriorityServiceTier("priority", model("anthropic", "anthropic-messages", "claude-3"))).toBe(true);
	});
	it("returns true for openai with priority wire tier", () => {
		expect(realizesPriorityServiceTier("priority", model("openai", "openai-completions", "gpt-4"))).toBe(true);
	});
	it("returns true for openrouter with openai family", () => {
		expect(realizesPriorityServiceTier("priority", model("openrouter", "openai-completions", "openai/gpt-4"))).toBe(
			true,
		);
	});
	it("returns true for openrouter with google family", () => {
		expect(
			realizesPriorityServiceTier("priority", model("openrouter", "openai-completions", "google/gemini-1.5")),
		).toBe(true);
	});
	it("returns false for openrouter with unknown family", () => {
		expect(
			realizesPriorityServiceTier("priority", model("openrouter", "openai-completions", "mistral/mistral-7b")),
		).toBe(false);
	});
	it("returns false for anthropic-messages on non-anthropic provider without capability", () => {
		expect(realizesPriorityServiceTier("priority", model("custom", "anthropic-messages", "claude-3"))).toBe(false);
	});
});

describe("getPriorityPremiumRequests", () => {
	it("returns 0 for non-priority tier", () => {
		expect(getPriorityPremiumRequests("flex", model("openai", "openai-completions", "gpt-4"))).toBe(0);
	});
	it("returns 0 for null", () => {
		expect(getPriorityPremiumRequests(null, model("openai", "openai-completions", "gpt-4"))).toBe(0);
	});
	it("returns 1 for anthropic priority (premiumPriority)", () => {
		expect(getPriorityPremiumRequests("priority", model("anthropic", "anthropic-messages", "claude-3"))).toBe(1);
	});
	it("returns 1 for openai priority (premiumPriority)", () => {
		expect(getPriorityPremiumRequests("priority", model("openai", "openai-completions", "gpt-4"))).toBe(1);
	});
	it("returns 0 for fireworks priority (not premiumPriority)", () => {
		expect(getPriorityPremiumRequests("priority", model("fireworks", "openai-completions", "gpt-4"))).toBe(0);
	});
	it("returns 0 for openrouter priority (not premiumPriority)", () => {
		expect(getPriorityPremiumRequests("priority", model("openrouter", "openai-completions", "openai/gpt-4"))).toBe(0);
	});
});
