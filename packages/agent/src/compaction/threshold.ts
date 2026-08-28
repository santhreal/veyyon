import { clamp, clampLow } from "@veyyon/utils/math";

export const AUTO_COMPACTION_THRESHOLD = "auto";

export type CompactionThresholdSpec =
	| { kind: "auto"; invalidRaw?: string }
	| { kind: "percent"; percent: number }
	| { kind: "tokens"; tokens: number };

export type CompactionThresholdOrigin = "auto" | "percent" | "tokens";

export interface ResolvedCompactionThreshold {
	tokens: number;
	origin: CompactionThresholdOrigin;
	configured?: number;
	clamped: boolean;
	legacyKey?: "thresholdTokens" | "thresholdPercent";
	invalidRaw?: string;
}

export function parseCompactionThreshold(raw: string | number | undefined | null): CompactionThresholdSpec {
	if (raw === undefined || raw === null) return { kind: "auto" };

	if (typeof raw === "number") {
		if (!Number.isFinite(raw) || raw <= 0) return { kind: "auto" };
		return { kind: "tokens", tokens: raw };
	}

	const text = raw.trim().toLowerCase();
	if (text === "" || text === AUTO_COMPACTION_THRESHOLD || text === "default") return { kind: "auto" };

	if (text.endsWith("%")) {
		const percent = Number(text.slice(0, -1).trim());
		if (!Number.isFinite(percent) || percent <= 0) return { kind: "auto" };
		return { kind: "percent", percent };
	}

	const tokens = Number(text.replace(/_/g, ""));
	if (!Number.isFinite(tokens)) return { kind: "auto", invalidRaw: raw };
	if (tokens <= 0) return { kind: "auto" };
	return { kind: "tokens", tokens };
}

export interface LegacyThresholdInputs {
	threshold?: string | number;
	thresholdTokens?: number;
	thresholdPercent?: number;
}

export function withLegacyCompactionThreshold(inputs: LegacyThresholdInputs): {
	spec: CompactionThresholdSpec;
	legacyKey?: "thresholdTokens" | "thresholdPercent";
} {
	const current = parseCompactionThreshold(inputs.threshold);
	if (current.kind !== "auto" || current.invalidRaw !== undefined) return { spec: current };

	const legacyTokens = parseCompactionThreshold(inputs.thresholdTokens);
	if (legacyTokens.kind === "tokens") return { spec: legacyTokens, legacyKey: "thresholdTokens" };

	const legacyPercent = inputs.thresholdPercent;
	if (typeof legacyPercent === "number" && Number.isFinite(legacyPercent) && legacyPercent > 0) {
		return { spec: { kind: "percent", percent: legacyPercent }, legacyKey: "thresholdPercent" };
	}

	return { spec: { kind: "auto" } };
}

const MIN_THRESHOLD_PERCENT = 1;
const MAX_THRESHOLD_PERCENT = 99;

export function resolveCompactionThreshold(
	contextWindow: number,
	inputs: LegacyThresholdInputs,
	autoTokens: () => number,
): ResolvedCompactionThreshold {
	const { spec, legacyKey } = withLegacyCompactionThreshold(inputs);

	if (spec.kind === "tokens") {
		const ceiling = clampLow(autoTokens(), 1, contextWindow - 1);
		const tokens = clampLow(Math.min(spec.tokens, ceiling), 1, contextWindow - 1);
		return { tokens, origin: "tokens", configured: spec.tokens, clamped: spec.tokens > ceiling, legacyKey };
	}

	if (spec.kind === "percent") {
		const clampedPercent = clamp(spec.percent, MIN_THRESHOLD_PERCENT, MAX_THRESHOLD_PERCENT);
		return {
			tokens: Math.floor(contextWindow * (clampedPercent / 100)),
			origin: "percent",
			configured: spec.percent,
			clamped: clampedPercent !== spec.percent,
			legacyKey,
		};
	}

	return {
		tokens: clampLow(autoTokens(), 0, contextWindow - 1),
		origin: "auto",
		clamped: false,
		legacyKey,
		invalidRaw: spec.invalidRaw,
	};
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return String(tokens);
}

export function formatCompactionThreshold(resolved: ResolvedCompactionThreshold, contextWindow: number): string {
	const tokens = formatTokens(resolved.tokens);
	if (resolved.origin === "percent") {
		return `${tokens} (${resolved.configured}% of ${formatTokens(contextWindow)})`;
	}
	if (resolved.origin === "tokens") {
		return resolved.clamped
			? `${tokens} (fixed ${formatTokens(resolved.configured ?? 0)}, capped to the most a ${formatTokens(contextWindow)}-window model can reach)`
			: `${tokens} (fixed)`;
	}
	return `${tokens} (auto: ${formatTokens(contextWindow)} window minus reserve)`;
}

export interface CompactionSettings {
	enabled: boolean;
	strategy?: "handoff" | "summary";
	threshold?: string;
	thresholdPercent?: number;
	thresholdTokens?: number;
	midTurnEnabled?: boolean;
	reserveTokens?: number;
	keepRecentTokens: number;
	autoContinue?: boolean;
	remoteEndpoint?: string;
}

export const DEFAULT_RESERVE_TOKENS = 16384;

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	strategy: "summary",
	threshold: AUTO_COMPACTION_THRESHOLD,
	thresholdPercent: -1,
	thresholdTokens: -1,
	midTurnEnabled: true,
	keepRecentTokens: 10000,
	autoContinue: true,
};

export function effectiveReserveTokens(contextWindow: number, settings: CompactionSettings): number {
	return Math.max(Math.floor(contextWindow * 0.15), settings.reserveTokens ?? DEFAULT_RESERVE_TOKENS);
}

export function resolveBudgetReserveTokens(contextWindow: number, settings: CompactionSettings): number {
	const reserveTokens = effectiveReserveTokens(contextWindow, settings);
	const proportionalReserveTokens = Math.max(1, Math.floor(contextWindow * 0.15));
	const reserveWasDefaulted = settings.reserveTokens === undefined;
	const defaultReserveIsEffectivelyImpossible =
		reserveWasDefaulted && reserveTokens >= contextWindow - proportionalReserveTokens;
	const reserveExceedsWindow = reserveTokens >= contextWindow;

	return defaultReserveIsEffectivelyImpossible || reserveExceedsWindow ? proportionalReserveTokens : reserveTokens;
}

export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled || contextWindow <= 0) return false;
	const thresholdTokens = resolveThresholdTokens(contextWindow, settings);
	return contextTokens > thresholdTokens;
}

export function resolveThresholdWithOrigin(
	contextWindow: number,
	settings: CompactionSettings,
): ResolvedCompactionThreshold {
	return resolveCompactionThreshold(
		contextWindow,
		settings,
		() => contextWindow - resolveBudgetReserveTokens(contextWindow, settings),
	);
}

export function resolveThresholdTokens(contextWindow: number, settings: CompactionSettings): number {
	return resolveThresholdWithOrigin(contextWindow, settings).tokens;
}

export function isThresholdTokensClampedForWindow(contextWindow: number, settings: CompactionSettings): boolean {
	const resolved = resolveThresholdWithOrigin(contextWindow, settings);
	return resolved.origin === "tokens" && resolved.clamped;
}
