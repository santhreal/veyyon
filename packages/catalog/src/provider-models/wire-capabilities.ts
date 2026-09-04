/**
 * What a provider realizes on the wire, declared once per provider.
 *
 * A per-provider capability written where it was needed reads as
 * `provider === "x" || provider === "y"`, so one provider's behavior ends up
 * spread over lists in three packages and none of the lists states what it is
 * deciding. The failure mode is fail-open: a provider added to the catalog
 * inherits whatever each unrelated `else` branch happens to say, and the
 * missing entry surfaces months later as a provider-specific bug.
 *
 * This table is the single home. One entry per provider, one field per
 * capability, read through {@link providerWireCapabilities}. A provider with
 * no entry realizes none of these capabilities, and
 * `packages/catalog/test/every-provider-declares-what-it-realizes-on-the-wire.test.ts`
 * pins that opt-out set by exact equality, so a new provider is red until
 * someone records a decision for it.
 *
 * The table is a leaf and stays one: every import here is type-only, so a
 * caller reading one boolean does not pull the descriptor table's forty
 * model-manager factories, or the model-identity subtree, onto its graph. The
 * readers that need identity live in `service-tier.ts`.
 */

import {
	isServiceTier,
	OPENAI_WIRE_TIERS,
	type ProviderWireCapabilities,
	type ServiceTierByFamily,
} from "@veyyon/model/service-tier";
import type { KnownProvider } from "./descriptors";

export * from "@veyyon/model/service-tier";

/**
 * A provider id with no catalog entry: a local server a user points at by hand,
 * so nothing generates models for it and it never appears in `CATALOG_PROVIDERS`.
 * The sweep pins this set, so a typo in a key below cannot pass as one of these.
 */
type ProviderWithoutCatalogEntry = "llama.cpp";

const PROVIDER_WIRE_CAPABILITIES: Partial<
	Record<KnownProvider | ProviderWithoutCatalogEntry, ProviderWireCapabilities>
> = {
	anthropic: {
		anthropicMessages: { directEndpoint: true },
		serviceTier: {
			family: "anthropic",
			wireTiers: [],
			realizesPriorityOffWire: true,
			premiumPriority: true,
		},
	},
	cerebras: { strictTools: true },
	fireworks: {
		// Fireworks Serverless realizes only its own Priority serving path, so no
		// family knob governs it and an OpenAI model id served here is not the
		// OpenAI family either.
		serviceTier: { wireTiers: ["priority"], premiumPriority: false },
	},
	"cloudflare-ai-gateway": { anthropicMessages: { credential: "gateway-managed" } },
	"github-copilot": {
		// The Copilot proxy accepts no Anthropic beta feature, and its model list
		// rejects a model per request rather than per key, so a rejection is retried.
		anthropicMessages: {
			credential: "copilot-bearer",
			rejectsBetas: true,
			rejectsContextManagement: true,
			transientModelErrors: true,
		},
		strictTools: true,
	},
	google: {
		serviceTier: {
			family: "google",
			anthropicMessagesOverridesFamily: true,
			wireTiers: ["flex", "priority"],
			premiumPriority: true,
		},
	},
	"google-vertex": {
		anthropicMessages: { rejectsContextManagement: true },
		// Vertex realizes only priority (via header); flex has no documented control.
		serviceTier: {
			family: "google",
			anthropicMessagesOverridesFamily: true,
			wireTiers: ["priority"],
			premiumPriority: true,
		},
	},
	litellm: { forwardsUpstream: true },
	"llama.cpp": { localInference: true },
	"lm-studio": { localInference: true },
	ollama: { localInference: true },
	openai: {
		serviceTier: { family: "openai", wireTiers: OPENAI_WIRE_TIERS, premiumPriority: true },
		strictTools: true,
	},
	"openai-codex": { serviceTier: { family: "openai", wireTiers: OPENAI_WIRE_TIERS, premiumPriority: true } },
	"opencode-go": { anthropicMessages: { credential: "api-key-header" } },
	"opencode-zen": { anthropicMessages: { credential: "bearer-only" } },
	openrouter: {
		// Billed per OpenRouter's own pricing, not Copilot-premium semantics.
		serviceTier: {
			family: "model-namespace",
			wireTiers: OPENAI_WIRE_TIERS,
			realizesPriorityForFamilies: ["openai", "google"],
			premiumPriority: false,
		},
		strictTools: true,
	},
	together: { strictTools: true },
	umans: { anthropicMessages: { credential: "api-key-header", gatewayWebSearch: true } },
	vllm: { localInference: true },
	zenmux: { strictTools: true },
};

/** The one accessor. `undefined` means the provider declares no wire capability. */
export function providerWireCapabilities(provider: string | undefined): ProviderWireCapabilities | undefined {
	if (!provider) return undefined;
	return PROVIDER_WIRE_CAPABILITIES[provider as KnownProvider];
}

/** Every provider that declares `capability`. Read by the sweep, not by a request. */
export function providersDeclaring(capability: keyof ProviderWireCapabilities): readonly string[] {
	return Object.keys(PROVIDER_WIRE_CAPABILITIES).filter(
		id => PROVIDER_WIRE_CAPABILITIES[id as KnownProvider]?.[capability] !== undefined,
	);
}

/** Every provider with a declaration. Read by the sweep, not by a request. */
export function declaredProviders(): readonly string[] {
	return Object.keys(PROVIDER_WIRE_CAPABILITIES);
}

/**
 * Every capability name some provider declares, taken from the table itself so
 * the sweep sees a new one without being told about it.
 */
export function declaredCapabilityNames(): readonly string[] {
	const names = new Set<string>();
	for (const entry of Object.values(PROVIDER_WIRE_CAPABILITIES)) {
		for (const name of Object.keys(entry)) names.add(name);
	}
	return Array.from(names).sort();
}

/**
 * Coerce a persisted service-tier value to a {@link ServiceTierByFamily}. Newer
 * sessions store the family map directly; legacy sessions stored a single
 * scalar — `"priority"` applied everywhere, `"openai-only"`/`"claude-only"`
 * scoped to one family, and the remaining values were OpenAI-only semantics.
 */
export function coerceServiceTierByFamily(value: unknown): ServiceTierByFamily | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value === "object") {
		const src = value as Record<string, unknown>;
		const out: ServiceTierByFamily = {};
		for (const family of ["openai", "anthropic", "google"] as const) {
			const tier = src[family];
			if (isServiceTier(tier)) out[family] = tier;
		}
		return Object.keys(out).length > 0 ? out : undefined;
	}
	if (typeof value !== "string") return undefined;
	if (value === "priority") return { openai: "priority", anthropic: "priority", google: "priority" };
	if (value === "openai-only") return { openai: "priority" };
	if (value === "claude-only") return { anthropic: "priority" };
	return isServiceTier(value) ? { openai: value } : undefined;
}
