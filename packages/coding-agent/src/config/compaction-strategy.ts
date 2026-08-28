import { resolveThresholdTokens } from "@veyyon/agent-core/compaction/threshold";

export type CompactionStrategySetting = "summary";

export type CompactionEngineAction = "context-full";

export function normalizeCompactionStrategy(_value: string | undefined): CompactionStrategySetting {
	return "summary";
}

export function compactionStrategyToEngineAction(_strategy: CompactionStrategySetting): CompactionEngineAction {
	return "context-full";
}

export function resolveCompactionEngineAction(rawStrategy: string | undefined): CompactionEngineAction {
	return compactionStrategyToEngineAction(normalizeCompactionStrategy(rawStrategy));
}

export function isCompactionStrategyOff(strategy: string | undefined): boolean {
	return strategy === "off";
}

export function isThresholdCompactionDisabled(enabled: boolean, strategy: string | undefined): boolean {
	return !enabled || strategy === "off";
}

export type ContextLimitKind = "window" | "compaction";

export interface ResolvedContextLimit {
	readonly tokens: number;
	readonly kind: ContextLimitKind;
}

export function resolveContextLimit(
	contextWindow: number,
	settings: import("@veyyon/agent-core/compaction/threshold").CompactionSettings,
): ResolvedContextLimit {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return { tokens: 0, kind: "window" };
	if (isThresholdCompactionDisabled(settings.enabled, settings.strategy)) {
		return { tokens: contextWindow, kind: "window" };
	}
	const threshold = resolveThresholdTokens(contextWindow, settings);
	if (!(threshold > 0)) return { tokens: contextWindow, kind: "window" };
	return { tokens: Math.min(threshold, contextWindow), kind: "compaction" };
}

export function migrateCompactionStrategyValue(value: unknown): CompactionStrategySetting | undefined {
	if (typeof value !== "string") return undefined;
	return normalizeCompactionStrategy(value);
}

export function toAgentCompactionSettings(
	settings: Omit<import("./settings-schema").CompactionSettings, "strategy" | "model"> & {
		strategy?: string;
		model?: string;
	},
): import("@veyyon/agent-core/compaction/threshold").CompactionSettings {
	const strategy = normalizeCompactionStrategy(settings.strategy);
	return { ...settings, strategy } as import("@veyyon/agent-core/compaction/threshold").CompactionSettings;
}
