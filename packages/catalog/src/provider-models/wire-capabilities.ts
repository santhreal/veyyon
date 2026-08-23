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
 * The table is a leaf: `KnownProvider` is imported as a type, so nothing here
 * pulls the descriptor table's forty model-manager factories onto a caller's
 * graph.
 */
import { isOpenAIModelId } from "../identity/family";
import type { Api, Model } from "../types";
import type { KnownProvider } from "./descriptors";

/**
 * Service tier hint for processing priority / cost control. These are the
 * values providers consume on the wire:
 *
 * - OpenAI / OpenAI-Codex: sent verbatim as the `service_tier` field
 *   (`flex`/`scale`/`priority`).
 * - Google (Gemini API + Vertex AI): sent as the top-level `serviceTier`
 *   field (`flex`/`priority`).
 * - OpenRouter: passed through as `service_tier`; OpenRouter realizes it for
 *   the OpenAI- and Google-family upstreams it supports and ignores it
 *   otherwise.
 * - Direct Anthropic: `"priority"` is translated into `speed: "fast"` plus the
 *   fast-mode beta on supported Opus models. Other tiers are ignored.
 *
 * Per-family scoping is expressed by {@link ServiceTierByFamily}, not by
 * scoped sentinel values — see {@link serviceTierFamily}.
 */
export const SERVICE_TIERS = ["auto", "default", "flex", "scale", "priority"] as const;

export type ServiceTier = (typeof SERVICE_TIERS)[number];

/**
 * Is this a service tier?
 *
 * The type is derived from {@link SERVICE_TIERS} rather than declared beside it, so
 * the values exist exactly once and this guard cannot fall behind them. Both
 * OpenAI-compatible servers used to spell the five values again in a comparison
 * chain, which meant a new tier was accepted by the type system and silently
 * dropped from an incoming request.
 */
export function isServiceTier(value: unknown): value is ServiceTier {
	return typeof value === "string" && (SERVICE_TIERS as readonly string[]).includes(value);
}

/** Provider families that expose an independent service-tier knob. */
export type ServiceTierFamily = "openai" | "anthropic" | "google";

/**
 * Per-family service-tier selection. A request consults only the entry for the
 * family its model belongs to (see {@link resolveModelServiceTier}), so a user
 * can opt one family into priority without affecting the others when switching
 * models mid-session.
 */
export type ServiceTierByFamily = Partial<Record<ServiceTierFamily, ServiceTier>>;

/** The tiers the OpenAI service-tier field accepts, and the set an OpenAI-compatible relay inherits. */
const OPENAI_WIRE_TIERS = ["flex", "scale", "priority"] as const satisfies readonly ServiceTier[];

/** How one provider realizes a service tier. */
export interface ProviderServiceTierCapability {
	/**
	 * The family whose knob governs this provider. `"model-namespace"` means a
	 * gateway that fronts several vendors and is classified by the model id's
	 * vendor prefix. Absent means the provider owns a dedicated serving control
	 * and no family knob reaches it.
	 */
	readonly family?: ServiceTierFamily | "model-namespace";
	/**
	 * True when an `anthropic-messages` model on this provider is governed by
	 * the anthropic knob instead of `family` — Claude served through Vertex.
	 */
	readonly anthropicMessagesOverridesFamily?: boolean;
	/** Tiers sent as the provider's service-tier request field. Empty when the tier is realized off-field. */
	readonly wireTiers: readonly ServiceTier[];
	/** True when the provider realizes `priority` without the wire field — direct Anthropic's fast mode. */
	readonly realizesPriorityOffWire?: boolean;
	/** For a `"model-namespace"` gateway, the upstream families whose priority it actually realizes. */
	readonly realizesPriorityForFamilies?: readonly ServiceTierFamily[];
	/** True when a realized `priority` request bills as a premium request. */
	readonly premiumPriority: boolean;
}

/** Everything one provider declares about what it realizes on the wire. */
export interface ProviderWireCapabilities {
	readonly serviceTier?: ProviderServiceTierCapability;
}

const PROVIDER_WIRE_CAPABILITIES: Partial<Record<KnownProvider, ProviderWireCapabilities>> = {
	anthropic: {
		serviceTier: {
			family: "anthropic",
			wireTiers: [],
			realizesPriorityOffWire: true,
			premiumPriority: true,
		},
	},
	fireworks: {
		// Fireworks Serverless realizes only its own Priority serving path, so no
		// family knob governs it and an OpenAI model id served here is not the
		// OpenAI family either.
		serviceTier: { wireTiers: ["priority"], premiumPriority: false },
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
		// Vertex realizes only priority (via header); flex has no documented control.
		serviceTier: {
			family: "google",
			anthropicMessagesOverridesFamily: true,
			wireTiers: ["priority"],
			premiumPriority: true,
		},
	},
	openai: { serviceTier: { family: "openai", wireTiers: OPENAI_WIRE_TIERS, premiumPriority: true } },
	"openai-codex": { serviceTier: { family: "openai", wireTiers: OPENAI_WIRE_TIERS, premiumPriority: true } },
	openrouter: {
		// Billed per OpenRouter's own pricing, not Copilot-premium semantics.
		serviceTier: {
			family: "model-namespace",
			wireTiers: OPENAI_WIRE_TIERS,
			realizesPriorityForFamilies: ["openai", "google"],
			premiumPriority: false,
		},
	},
};

/** The one accessor. `undefined` means the provider declares no wire capability. */
export function providerWireCapabilities(provider: string | undefined): ProviderWireCapabilities | undefined {
	if (!provider) return undefined;
	return PROVIDER_WIRE_CAPABILITIES[provider as KnownProvider];
}

/** Every provider that declares a service-tier capability. Read by the sweep, not by a request. */
export function providersDeclaringServiceTier(): readonly string[] {
	return Object.keys(PROVIDER_WIRE_CAPABILITIES).filter(
		id => PROVIDER_WIRE_CAPABILITIES[id as KnownProvider]?.serviceTier !== undefined,
	);
}

type ServiceTierModel = Pick<Model, "provider" | "api" | "id">;

function isOpenAIServiceTierApi(api: Api | undefined): boolean {
	return api === "openai-completions" || api === "openai-responses" || api === "openai-codex-responses";
}

/**
 * A custom OpenAI-compatible relay serving an OpenAI model id: the OpenAI
 * family reaches it through the model, not through a declaration. Both callers
 * ask the declaration first, so this answers only for a provider that declares
 * nothing — which is why Fireworks, whose own entry names its dedicated serving
 * control, never inherits the OpenAI knob through an OpenAI model id.
 */
function isOpenAIRelayModel(model: ServiceTierModel): boolean {
	return isOpenAIServiceTierApi(model.api) && isOpenAIModelId(model.id);
}

function namespaceFamily(modelId: string): ServiceTierFamily | undefined {
	const id = modelId.toLowerCase();
	if (id.startsWith("anthropic/")) return "anthropic";
	if (id.startsWith("google/")) return "google";
	if (id.startsWith("openai/")) return "openai";
	return undefined;
}

/**
 * Classify a model into the service-tier family whose knob governs it, or
 * `undefined` when the model exposes no serving-priority control.
 *
 * A gateway declaring `"model-namespace"` is classified by id namespace
 * (`anthropic/`, `google/`, `openai/`); Claude on Bedrock/Vertex (api
 * `anthropic-messages`) is the anthropic family even though its provider is
 * `amazon-bedrock`/`google-vertex`.
 */
export function serviceTierFamily(model: ServiceTierModel): ServiceTierFamily | undefined {
	const capability = providerWireCapabilities(model.provider)?.serviceTier;
	if (capability) {
		if (capability.family === "model-namespace") return namespaceFamily(model.id);
		if (capability.family && !capability.anthropicMessagesOverridesFamily) return capability.family;
		if (model.api === "anthropic-messages") return "anthropic";
		return capability.family;
	}
	if (model.api === "anthropic-messages") return "anthropic";
	return isOpenAIRelayModel(model) ? "openai" : undefined;
}

/**
 * Reduce a per-family tier map to the single wire tier for `model` — the entry
 * for the model's family, or `undefined` when the model has no family.
 */
export function resolveModelServiceTier(
	tiers: ServiceTierByFamily | null | undefined,
	model: ServiceTierModel,
): ServiceTier | undefined {
	if (!tiers) return undefined;
	const family = serviceTierFamily(model);
	return family ? tiers[family] : undefined;
}

/**
 * True when the tier should be sent on the wire as the provider's service-tier
 * request field: the provider declares it, or the request reaches an
 * OpenAI-compatible relay serving an OpenAI model id.
 */
export function shouldSendServiceTier(
	serviceTier: ServiceTier | null | undefined,
	target: string | ServiceTierModel | undefined,
): boolean {
	if (!serviceTier) return false;
	const provider = typeof target === "string" ? target : target?.provider;
	const capability = providerWireCapabilities(provider)?.serviceTier;
	if (capability) return capability.wireTiers.includes(serviceTier);
	if (typeof target !== "string" && target && isOpenAIRelayModel(target)) {
		return (OPENAI_WIRE_TIERS as readonly ServiceTier[]).includes(serviceTier);
	}
	return false;
}

/**
 * True when `priority` will actually be realized on the wire for `model`.
 * Bedrock/Vertex Claude and an OpenRouter Anthropic model do not realize
 * priority and return `false`.
 */
export function realizesPriorityServiceTier(
	serviceTier: ServiceTier | null | undefined,
	model: ServiceTierModel,
): boolean {
	if (serviceTier !== "priority") return false;
	const capability = providerWireCapabilities(model.provider)?.serviceTier;
	if (capability?.realizesPriorityOffWire) return true;
	if (capability?.realizesPriorityForFamilies) {
		const family = serviceTierFamily(model);
		return family !== undefined && capability.realizesPriorityForFamilies.includes(family);
	}
	if (model.api === "anthropic-messages") return false;
	return shouldSendServiceTier(serviceTier, model);
}

/**
 * Premium-request weight contributed by a priority request to a provider that
 * realizes it and bills extra. Mirrors GitHub Copilot's `premiumRequests`
 * accounting so the "premium requests" stat aggregates priority traffic across
 * the OpenAI family, direct Anthropic fast mode, and Google priority.
 */
export function getPriorityPremiumRequests(
	serviceTier: ServiceTier | null | undefined,
	model: ServiceTierModel,
): number {
	if (!realizesPriorityServiceTier(serviceTier, model)) return 0;
	return providerWireCapabilities(model.provider)?.serviceTier?.premiumPriority ? 1 : 0;
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
