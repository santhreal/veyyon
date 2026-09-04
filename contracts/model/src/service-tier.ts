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

/**
 * How one provider serves the `anthropic-messages` wire. Every entry here
 * replaces a `model.provider === "…"` comparison in the Anthropic client, where
 * the same seven providers were named across eighteen sites.
 */
export interface ProviderAnthropicMessagesCapability {
	/**
	 * Anthropic's own API. The Foundry endpoint override and its mTLS material
	 * apply, and so do the headers scoped to that endpoint; another provider
	 * serving this wire is reached at the base URL its model states.
	 */
	readonly directEndpoint?: boolean;
	/**
	 * Where the credential goes when the endpoint is not Anthropic's own:
	 * `copilot-bearer` a GitHub Copilot token, which also states the base URL;
	 * `gateway-managed` no credential from here at all; `api-key-header`
	 * `X-Api-Key` only, with no `Authorization`; `bearer-only` the reverse.
	 */
	readonly credential?: "copilot-bearer" | "gateway-managed" | "api-key-header" | "bearer-only";
	/** The endpoint rejects `anthropic-beta` features, and strict tool schemas with them. */
	readonly rejectsBetas?: boolean;
	/** The endpoint rejects the `clear_thinking` context-management edit. */
	readonly rejectsContextManagement?: boolean;
	/** Web search is served by a gateway header rather than the Anthropic server tool. */
	readonly gatewayWebSearch?: boolean;
	/** A model-level rejection from this endpoint is transient and the request is worth retrying. */
	readonly transientModelErrors?: boolean;
}

/** Everything one provider declares about what it realizes on the wire. */
export interface ProviderWireCapabilities {
	readonly serviceTier?: ProviderServiceTierCapability;
	readonly anthropicMessages?: ProviderAnthropicMessagesCapability;
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
