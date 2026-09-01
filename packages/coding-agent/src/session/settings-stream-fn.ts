/** Settings-aware stream wrapper shared by the main agent (sdk.ts) and the advisor agent (AgentSession.#buildAdvisorRuntime). */
import type { StreamFn } from "@veyyon/agent-core";
import { type SimpleStreamOptions, streamSimple } from "@veyyon/ai";
import { isAnthropicFableOrMythosModel } from "@veyyon/catalog/identity";
import { type Settings, validateProviderMaxInFlightRequests } from "../config/settings";

function timeoutSecondsToMs(value: number): number | undefined {
	if (!Number.isFinite(value) || value < 0) return undefined;
	if (value === 0) return 0;
	return Math.max(1, Math.trunc(value * 1000));
}

/** Build a {@link StreamFn} that reads provider routing/guard settings from `settings` per call and forwards to `base` (defaults to `streamSimple`). */
export function createSettingsAwareStreamFn(settings: Settings, base: StreamFn = streamSimple): StreamFn {
	return (model, context, streamOptions) => {
		const openrouterRoutingPreset = settings.get("providers.openrouterVariant");
		const openrouterVariant =
			openrouterRoutingPreset && openrouterRoutingPreset !== "default" ? openrouterRoutingPreset : undefined;
		const antigravityEndpointMode = settings.get("providers.antigravityEndpoint");
		const textVerbosity =
			model.api === "openai-codex-responses" || model.api === "openai-responses"
				? settings.get("textVerbosity")
				: undefined;
		const streamFirstEventTimeoutMs = timeoutSecondsToMs(settings.get("providers.streamFirstEventTimeoutSeconds"));
		const streamIdleTimeoutMs = timeoutSecondsToMs(settings.get("providers.streamIdleTimeoutSeconds"));
		// Server-side fallback (opt-in): when the user enables it AND the resolved model is a Claude Fable/Mythos on Anthropic's messages
		const serverSideFallbackEnabled =
			settings.get("providers.anthropic.serverSideFallback") &&
			model.api === "anthropic-messages" &&
			model.provider === "anthropic" &&
			isAnthropicFableOrMythosModel(model.id);
		const fallbacks =
			streamOptions?.fallbacks ?? (serverSideFallbackEnabled ? [{ model: "claude-opus-4-8" }] : undefined);
		const merged: SimpleStreamOptions = {
			...streamOptions,
			openrouterVariant: streamOptions?.openrouterVariant ?? openrouterVariant,
			antigravityEndpointMode: streamOptions?.antigravityEndpointMode ?? antigravityEndpointMode,
			textVerbosity: streamOptions?.textVerbosity ?? textVerbosity,
			streamFirstEventTimeoutMs: streamOptions?.streamFirstEventTimeoutMs ?? streamFirstEventTimeoutMs,
			streamIdleTimeoutMs: streamOptions?.streamIdleTimeoutMs ?? streamIdleTimeoutMs,
			maxInFlightRequests: validateProviderMaxInFlightRequests(
				streamOptions?.maxInFlightRequests ?? settings.get("providers.maxInFlightRequests"),
			),
			loopGuard: {
				enabled: settings.get("model.loopGuard.enabled"),
				checkAssistantContent: settings.get("model.loopGuard.checkAssistantContent"),
				...streamOptions?.loopGuard,
			},
			hideThinkingSummary: streamOptions?.hideThinkingSummary ?? settings.get("omitThinking"),
			...(fallbacks !== undefined ? { fallbacks } : {}),
		};
		return base(model, context, merged);
	};
}
