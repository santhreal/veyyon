/**
 * Token limits for an agent-gateway model, resolved from what is actually known about that model.
 *
 * WHY THIS EXISTS. Antigravity, Cursor and Devin are gateways: they proxy other vendors' models and report
 * little or nothing about the limits of what they are proxying. Cursor reports no limits at all, Devin reports
 * one number that has to serve as both, and Antigravity's fields are frequently absent. Every one of the three
 * used to fall straight to {@link AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW}, so a gateway-hosted `grok-4.5` was
 * described as a 200k model when the model has a 500k window, and a Gemini row as 200k against 1M. That number
 * is not cosmetic: auto-compaction, the context panel, context promotion and the overflow check all read it, so
 * the agent compacted at two fifths of the window it had and told the operator their 256k threshold was larger
 * than the model's context.
 *
 * WHAT IS DIFFERENT NOW. The gateway not reporting a window does not mean nothing is known about the model. The
 * bundled catalog carries the same model under the vendor that hosts it directly (`xai/grok-4.5`,
 * `google/gemini-3-pro`), and the reference index already resolves a proxied id onto that entry — it is what the
 * proxy/reseller path uses for pricing and capabilities. So the order is: what the gateway reported, then what
 * the catalog knows about that model, and only then the gateway assumption.
 *
 * The assumption is still the floor rather than the answer, because being too LOW is the safe direction: an
 * over-estimate makes the agent keep filling a window the model does not have until the provider rejects the
 * request, while an under-estimate only compacts earlier than it needed to.
 */
import { getBundledModelReferenceIndex } from "../identity/bundled";
import { resolveModelReference } from "../identity/reference";
import type { Api, Model } from "../types";
import { stripEffortTierSuffix } from "../variant-collapse";
import { AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW, AGENT_GATEWAY_DEFAULT_MAX_TOKENS } from "./default-limits";

/** A limit a gateway reported. Anything not a positive finite number is "not told", not zero. */
function reportedLimit(value: number | null | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The catalog's own entry for a gateway model id, or undefined when the id names nothing known.
 *
 * An effort-tiered id (`grok-4.5-medium`, `gpt-5.4-medium-fast`) is the base model at a fixed effort, so it
 * resolves through its base: the tier changes how the model thinks, never how much context it has.
 */
export function gatewayModelReference(modelId: string): Model<Api> | undefined {
	const index = getBundledModelReferenceIndex();
	const direct = resolveModelReference(modelId, index);
	if (direct) return direct;
	const tierBase = stripEffortTierSuffix(modelId);
	return tierBase === undefined ? undefined : resolveModelReference(tierBase, index);
}

/**
 * Resolve a gateway model's context window: reported, else the catalog's number for that model, else the
 * gateway assumption.
 */
export function gatewayContextWindow(modelId: string, reported?: number): number {
	const told = reportedLimit(reported);
	if (told !== undefined) return told;
	const known = reportedLimit(gatewayModelReference(modelId)?.contextWindow);
	return known ?? AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW;
}

/**
 * Resolve a gateway model's output cap the same way.
 *
 * Unlike the context window this is capped at the gateway assumption when it comes from the catalog: an output
 * budget above what the gateway will actually produce is refused outright by some of them rather than clamped,
 * and the vendor's own cap is not a promise about the proxy. A number the gateway itself reported is trusted as
 * given, because that one IS a statement about the proxy.
 */
export function gatewayMaxTokens(modelId: string, reported?: number): number {
	const told = reportedLimit(reported);
	if (told !== undefined) return told;
	const known = reportedLimit(gatewayModelReference(modelId)?.maxTokens);
	return known === undefined ? AGENT_GATEWAY_DEFAULT_MAX_TOKENS : Math.min(known, AGENT_GATEWAY_DEFAULT_MAX_TOKENS);
}
