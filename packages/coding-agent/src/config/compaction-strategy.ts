/**
 * User-facing compaction strategy normalization.
 *
 * `summary` is the only compaction strategy: it condenses persisted history in
 * place and continues the same session. Every previously stored strategy,
 * including `handoff`, migrates to this canonical path. Session transfer remains
 * available only through the explicit `/handoff` operation.
 */

// `compaction/threshold`, not `compaction`. The subpath barrel re-exports the compaction ENGINE, which
// imports the `@veyyon/ai` barrel and the prompt registry to summarize a conversation; deciding whether a
// token count is over the trigger is arithmetic. This edge is why `config/settings.ts` reached
// `@veyyon/ai/stream.ts` while a gate two directories away asserted that it did not.
import { resolveThresholdTokens } from "@veyyon/agent-core/compaction/threshold";

/** Stored compaction strategy after migration / schema validation. */
export type CompactionStrategySetting = "summary";

/** The single engine action used by automatic and manual compaction. */
export type CompactionEngineAction = "context-full";

/** Normalize every persisted or runtime strategy token to the canonical strategy. */
export function normalizeCompactionStrategy(_value: string | undefined): CompactionStrategySetting {
	return "summary";
}

/** Map the canonical strategy to the sole compaction engine action. */
export function compactionStrategyToEngineAction(_strategy: CompactionStrategySetting): CompactionEngineAction {
	return "context-full";
}

/** Map stored or legacy strategy to the engine action for auto-compaction. */
export function resolveCompactionEngineAction(rawStrategy: string | undefined): CompactionEngineAction {
	return compactionStrategyToEngineAction(normalizeCompactionStrategy(rawStrategy));
}

/** Whether compaction is disabled via legacy `off` strategy. */
export function isCompactionStrategyOff(strategy: string | undefined): boolean {
	return strategy === "off";
}

/** Whether threshold/overflow auto-compaction is disabled (idle has its own gate). */
export function isThresholdCompactionDisabled(enabled: boolean, strategy: string | undefined): boolean {
	return !enabled || strategy === "off";
}

/** Which number a context gauge is measuring against. */
export type ContextLimitKind = "window" | "compaction";

export interface ResolvedContextLimit {
	/** Tokens at which the context runs out. Never above the window. */
	readonly tokens: number;
	/** `compaction` when the limit is the auto-compaction fire point. */
	readonly kind: ContextLimitKind;
}

/**
 * When the context runs out: the auto-compaction fire point, or the model window
 * when nothing will fire. The ONE owner of that question.
 *
 * It had three answers. The status line asked
 * `enabled && !isCompactionStrategyOff(strategy)`, the `/context` panel hand-rolled
 * `enabled && strategy !== "off"`, and `AgentSession.autoCompactionEnabled` used the
 * canonical `isThresholdCompactionDisabled` — three spellings of one predicate, so the
 * two surfaces could disagree about whether a fire point exists at all, and a fourth
 * caller would have spelled it a fourth way. They agree today only by luck; a change
 * to what counts as "off" would have had to be made in three places and would have
 * been made in one.
 *
 * `tokens` is always inside the window, which is the invariant callers rely on when
 * they render `window - tokens` as a buffer. `resolveThresholdTokens` guarantees it
 * for both threshold origins: a percentage caps at 99% of the window, and an absolute
 * amount is honored only up to `window - 1` (and reports the clamp separately through
 * `isThresholdTokensClampedForWindow`, so an operator whose model-independent amount
 * was capped for a smaller model hears about it).
 */
export function resolveContextLimit(
	contextWindow: number,
	settings: import("@veyyon/agent-core/compaction/threshold").CompactionSettings,
): ResolvedContextLimit {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return { tokens: 0, kind: "window" };
	if (isThresholdCompactionDisabled(settings.enabled, settings.strategy)) {
		return { tokens: contextWindow, kind: "window" };
	}
	const threshold = resolveThresholdTokens(contextWindow, settings);
	// A non-positive threshold means no usable fire point was configured.
	if (!(threshold > 0)) return { tokens: contextWindow, kind: "window" };
	return { tokens: Math.min(threshold, contextWindow), kind: "compaction" };
}

/** Migrate any legacy strategy value to the stored `summary` enum. */
export function migrateCompactionStrategyValue(value: unknown): CompactionStrategySetting | undefined {
	if (typeof value !== "string") return undefined;
	return normalizeCompactionStrategy(value);
}

/** Map profile compaction settings to the agent compaction module shape. */
export function toAgentCompactionSettings(
	settings: Omit<import("./settings-schema").CompactionSettings, "strategy" | "model"> & {
		strategy?: string;
		model?: string;
	},
): import("@veyyon/agent-core/compaction/threshold").CompactionSettings {
	const strategy = normalizeCompactionStrategy(settings.strategy);
	return { ...settings, strategy } as import("@veyyon/agent-core/compaction/threshold").CompactionSettings;
}
