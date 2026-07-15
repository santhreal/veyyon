/**
 * User-facing compaction strategy (`handoff` | `snap`) and legacy normalization.
 */

/** Stored compaction strategy after migration / schema validation. */
export type CompactionStrategySetting = "handoff" | "snap";

/** Engine action selected from a normalized user strategy. */
export type CompactionEngineAction = "handoff" | "snapcompact" | "context-full";

const LEGACY_SNAP = new Set(["snap", "snapcompact"]);
/** Legacy in-session strategies folded into handoff (LLM summarize / session transfer). */
const LEGACY_HANDOFF = new Set(["handoff", "context-full", "shake"]);

/** Normalize any persisted or runtime strategy token to `handoff` | `snap`. */
export function normalizeCompactionStrategy(value: string | undefined): CompactionStrategySetting {
	if (value && LEGACY_SNAP.has(value)) return "snap";
	if (value && LEGACY_HANDOFF.has(value)) return "handoff";
	return "snap";
}

/** Map a normalized strategy to the compaction engine action for auto-compaction. */
export function compactionStrategyToEngineAction(
	strategy: CompactionStrategySetting,
	options?: { reason?: "overflow" | "threshold" | "idle" | "incomplete"; suppressHandoff?: boolean },
): CompactionEngineAction {
	if (strategy === "snap") return "snapcompact";
	if (strategy === "handoff" && options?.reason !== "overflow" && !options?.suppressHandoff) return "handoff";
	return "context-full";
}

/** Map stored or legacy strategy to the engine action for auto-compaction. */
export function resolveCompactionEngineAction(
	rawStrategy: string | undefined,
	options?: { reason?: "overflow" | "threshold" | "idle" | "incomplete"; suppressHandoff?: boolean },
): CompactionEngineAction {
	if (rawStrategy === "context-full" || rawStrategy === "shake") return "context-full";
	if (rawStrategy === "snapcompact") return "snapcompact";
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

/** Migrate a legacy strategy value to the stored `handoff` | `snap` enum. */
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
): import("@veyyon/pi-agent-core/compaction").CompactionSettings {
	const raw = settings.strategy;
	const strategy = raw === "snap" ? "snapcompact" : raw;
	return { ...settings, strategy } as import("@veyyon/pi-agent-core/compaction").CompactionSettings;
}
