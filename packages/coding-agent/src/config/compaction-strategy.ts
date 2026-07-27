/**
 * User-facing compaction strategy (`handoff` | `summary`) and legacy normalization.
 *
 * Two pure-LLM strategies remain:
 *   - `summary`  — summarize the transcript in place and continue the same
 *                  session (engine action `context-full`). This is the default
 *                  and the successor to the removed image-archive `snap` mode.
 *   - `handoff`  — generate a session transfer and continue in a new session.
 */

// `compaction/threshold`, not `compaction`. The subpath barrel re-exports the compaction ENGINE, which
// imports the `@veyyon/ai` barrel and the prompt registry to summarize a conversation; deciding whether a
// token count is over the trigger is arithmetic. This edge is why `config/settings.ts` reached
// `@veyyon/ai/stream.ts` while a gate two directories away asserted that it did not.
import { resolveThresholdTokens } from "@veyyon/agent-core/compaction/threshold";

/** Stored compaction strategy after migration / schema validation. */
export type CompactionStrategySetting = "handoff" | "summary";

/** Engine action selected from a normalized user strategy. */
export type CompactionEngineAction = "handoff" | "context-full";

/**
 * Legacy in-session strategies folded into `summary` (LLM summarize in place).
 * `snap`/`snapcompact` were the removed image-archive engine; they now degrade
 * to a standard LLM summary. `shake`/`context-full` were always summary paths.
 */
const LEGACY_SUMMARY = new Set(["summary", "snap", "snapcompact", "context-full", "shake"]);

/** Normalize any persisted or runtime strategy token to `handoff` | `summary`. */
export function normalizeCompactionStrategy(value: string | undefined): CompactionStrategySetting {
	if (value === "handoff") return "handoff";
	if (value && LEGACY_SUMMARY.has(value)) return "summary";
	return "summary";
}

/** Map a normalized strategy to the compaction engine action for auto-compaction. */
export function compactionStrategyToEngineAction(
	strategy: CompactionStrategySetting,
	options?: { reason?: "overflow" | "threshold" | "idle" | "incomplete"; suppressHandoff?: boolean },
): CompactionEngineAction {
	if (strategy === "handoff" && options?.reason !== "overflow" && !options?.suppressHandoff) return "handoff";
	return "context-full";
}

/** Map stored or legacy strategy to the engine action for auto-compaction. */
export function resolveCompactionEngineAction(
	rawStrategy: string | undefined,
	options?: { reason?: "overflow" | "threshold" | "idle" | "incomplete"; suppressHandoff?: boolean },
): CompactionEngineAction {
	return compactionStrategyToEngineAction(normalizeCompactionStrategy(rawStrategy), options);
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

/** Migrate a legacy strategy value to the stored `handoff` | `summary` enum. */
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
