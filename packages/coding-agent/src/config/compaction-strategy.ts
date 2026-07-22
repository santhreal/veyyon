/**
 * User-facing compaction strategy (`handoff` | `summary`) and legacy normalization.
 *
 * Two pure-LLM strategies remain:
 *   - `summary`  — summarize the transcript in place and continue the same
 *                  session (engine action `context-full`). This is the default
 *                  and the successor to the removed image-archive `snap` mode.
 *   - `handoff`  — generate a session transfer and continue in a new session.
 */

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
): import("@veyyon/agent-core/compaction").CompactionSettings {
	const strategy = normalizeCompactionStrategy(settings.strategy);
	return { ...settings, strategy } as import("@veyyon/agent-core/compaction").CompactionSettings;
}
