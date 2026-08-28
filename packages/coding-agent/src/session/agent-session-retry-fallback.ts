/**
 * Retry fallback chains: the `provider/model` selector syntax the setting is
 * written in, and the parse and format of one.
 */

import type { ThinkingLevel } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { formatModelSelectorValue, formatModelStringWithRouting, parseModelString } from "../config/model-resolver";
import { type ConfiguredThinkingLevel, concreteThinkingLevel } from "../thinking";

/** Internal marker for hook messages queued through the agent loop */
// ============================================================================
// Constants
// ============================================================================
export /** Standard thinking levels */

/** `retry.fallbackChains` config: chain key (role name or model selector) → ordered fallback selectors. */
type RetryFallbackChains = Record<string, string[]>;

export type RetryFallbackRevertPolicy = "never" | "cooldown-expiry";

export interface RetryFallbackSelector {
	raw: string;
	provider: string;
	id: string;
	thinkingLevel: ThinkingLevel | undefined;
}

export interface ActiveRetryFallbackState {
	/** Chain key that produced this fallback: a model-role name or a model-selector key. */
	role: string;
	originalSelector: string;
	originalThinkingLevel: ConfiguredThinkingLevel | undefined;
	lastAppliedFallbackThinkingLevel: ConfiguredThinkingLevel | undefined;
	pinned: boolean;
}

export function parseRetryFallbackSelector(
	selector: string,
	modelLookup?: { find(provider: string, id: string): Model | undefined },
): RetryFallbackSelector | undefined {
	const trimmed = selector.trim();
	if (!trimmed) return undefined;
	const parsed = parseModelString(trimmed, {
		allowMaxSuffix: true,
		allowAutoAlias: true,
		isLiteralModelId: (provider, id) => modelLookup?.find(provider, id) !== undefined,
	});
	if (!parsed) return undefined;
	return {
		raw: trimmed,
		provider: parsed.provider,
		id: parsed.id,
		thinkingLevel: concreteThinkingLevel(parsed.thinkingLevel),
	};
}

/**
 * `retry.fallbackChains` keys are either model-role names (`smol`, `default`)
 * or model selectors (`provider/model-id[:thinking]`). Role names never
 * contain a slash, so its presence marks a model-keyed chain whose primary is
 * the key itself — the chain follows the model across role reassignments.
 */
export function isRetryFallbackModelKey(key: string): boolean {
	return key.includes("/");
}

/**
 * A `provider/*` fallback-chain key: matches any active model of that provider,
 * so one entry covers every current and future model behind the provider.
 */
export function isRetryFallbackWildcardKey(key: string): boolean {
	return key.endsWith("/*");
}

export function formatRetryFallbackSelector(model: Model, thinkingLevel: ThinkingLevel | undefined): string {
	return formatModelSelectorValue(formatModelStringWithRouting(model), thinkingLevel);
}

export function formatRetryFallbackBaseSelector(selector: RetryFallbackSelector): string {
	return `${selector.provider}/${selector.id}`;
}
