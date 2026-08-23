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
export const OPENAI_WIRE_TIERS = ["flex", "scale", "priority"] as const satisfies readonly ServiceTier[];

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
	/** True when the provider's OpenAI-compatible endpoint honors strict tool schemas. */
	readonly strictTools?: boolean;
	/**
	 * True when the provider is a local inference server whose chat template
	 * re-tokenizes the whole prompt every request — llama.cpp prefix-KV-cache
	 * reuse only survives while the rendered tokens stay byte-identical across
	 * turns, so the prior assistant turn's `<think>` block is replayed through
	 * `reasoning_content` (#3528).
	 */
	readonly localInference?: boolean;
	/**
	 * True when the provider listens on a loopback default but forwards to an
	 * unrelated upstream rather than rendering a chat template itself. Replaying
	 * `reasoning_content` at such a proxy gains no KV-cache benefit upstream and
	 * may 400 on the extra field, so it is excluded from both the local-inference
	 * declaration and the loopback heuristic; the sparse
	 * `compat.replayReasoningContent` override is how a custom proxy opts in.
	 */
	readonly forwardsUpstream?: boolean;
}

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
	"github-copilot": { strictTools: true },
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
	litellm: { forwardsUpstream: true },
	"llama.cpp": { localInference: true },
	"lm-studio": { localInference: true },
	ollama: { localInference: true },
	openai: {
		serviceTier: { family: "openai", wireTiers: OPENAI_WIRE_TIERS, premiumPriority: true },
		strictTools: true,
	},
	"openai-codex": { serviceTier: { family: "openai", wireTiers: OPENAI_WIRE_TIERS, premiumPriority: true } },
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
