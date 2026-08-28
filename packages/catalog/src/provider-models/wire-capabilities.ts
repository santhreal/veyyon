import type { KnownProvider } from "./descriptors";

export const SERVICE_TIERS = ["auto", "default", "flex", "scale", "priority"] as const;

export type ServiceTier = (typeof SERVICE_TIERS)[number];

export function isServiceTier(value: unknown): value is ServiceTier {
	return typeof value === "string" && (SERVICE_TIERS as readonly string[]).includes(value);
}

export type ServiceTierFamily = "openai" | "anthropic" | "google";

export type ServiceTierByFamily = Partial<Record<ServiceTierFamily, ServiceTier>>;

export const OPENAI_WIRE_TIERS = ["flex", "scale", "priority"] as const satisfies readonly ServiceTier[];

export interface ProviderServiceTierCapability {
	readonly family?: ServiceTierFamily | "model-namespace";
	readonly anthropicMessagesOverridesFamily?: boolean;
	readonly wireTiers: readonly ServiceTier[];
	readonly realizesPriorityOffWire?: boolean;
	readonly realizesPriorityForFamilies?: readonly ServiceTierFamily[];
	readonly premiumPriority: boolean;
}

export interface ProviderAnthropicMessagesCapability {
	readonly directEndpoint?: boolean;
	readonly credential?: "copilot-bearer" | "gateway-managed" | "api-key-header" | "bearer-only";
	readonly rejectsBetas?: boolean;
	readonly rejectsContextManagement?: boolean;
	readonly gatewayWebSearch?: boolean;
	readonly transientModelErrors?: boolean;
}

export interface ProviderWireCapabilities {
	readonly serviceTier?: ProviderServiceTierCapability;
	readonly anthropicMessages?: ProviderAnthropicMessagesCapability;
	readonly strictTools?: boolean;
	readonly localInference?: boolean;
	readonly forwardsUpstream?: boolean;
}

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
		serviceTier: { wireTiers: ["priority"], premiumPriority: false },
	},
	"cloudflare-ai-gateway": { anthropicMessages: { credential: "gateway-managed" } },
	"github-copilot": {
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

export function providerWireCapabilities(provider: string | undefined): ProviderWireCapabilities | undefined {
	if (!provider) return undefined;
	return PROVIDER_WIRE_CAPABILITIES[provider as KnownProvider];
}

export function providersDeclaring(capability: keyof ProviderWireCapabilities): readonly string[] {
	return Object.keys(PROVIDER_WIRE_CAPABILITIES).filter(
		id => PROVIDER_WIRE_CAPABILITIES[id as KnownProvider]?.[capability] !== undefined,
	);
}

export function declaredProviders(): readonly string[] {
	return Object.keys(PROVIDER_WIRE_CAPABILITIES);
}

export function declaredCapabilityNames(): readonly string[] {
	const names = new Set<string>();
	for (const entry of Object.values(PROVIDER_WIRE_CAPABILITIES)) {
		for (const name of Object.keys(entry)) names.add(name);
	}
	return Array.from(names).sort();
}

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
