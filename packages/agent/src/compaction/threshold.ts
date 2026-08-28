/** The one owner of "when does auto-compaction trigger?", which now includes the settings shape the */
import { clamp, clampLow } from "@veyyon/utils/math";

/** The value meaning "derive the threshold from the window and the reserve". */
export const AUTO_COMPACTION_THRESHOLD = "auto";

/** A parsed threshold. `invalidRaw` carries text that parsed as nothing. */
export type CompactionThresholdSpec =
	| { kind: "auto"; invalidRaw?: string }
	| { kind: "percent"; percent: number }
	| { kind: "tokens"; tokens: number };

/** Which key supplied the value the resolver used. */
export type CompactionThresholdOrigin = "auto" | "percent" | "tokens";

export interface ResolvedCompactionThreshold {
	/** Context tokens above which compaction triggers. */
	tokens: number;
	origin: CompactionThresholdOrigin;
	/** The amount the operator configured, before clamping: tokens for `tokens`, */
	configured?: number;
	/** True when the configured amount exceeds the current window, so the */
	clamped: boolean;
	/** Set when the value came from a retired key rather than `compaction.threshold`, */
	legacyKey?: "thresholdTokens" | "thresholdPercent";
	/** Set when the configured text parsed as nothing and `auto` was used instead. */
	invalidRaw?: string;
}

/** Parse a threshold value. Accepts `auto`, a percent (`85%`, `85 %`), or an */
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

/** Inputs the migration needs: the current key plus the two retired ones. */
export interface LegacyThresholdInputs {
	threshold?: string | number;
	thresholdTokens?: number;
	thresholdPercent?: number;
}

/** Resolve which of the three keys supplies the threshold, preserving the exact */
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

/** Percent thresholds are clamped here so a hand-edited `150%` cannot disable compaction. */
const MIN_THRESHOLD_PERCENT = 1;
const MAX_THRESHOLD_PERCENT = 99;

/** Resolve the threshold to tokens for a given window, reporting WHERE the number */
export function resolveCompactionThreshold(
	contextWindow: number,
	inputs: LegacyThresholdInputs,
	autoTokens: () => number,
): ResolvedCompactionThreshold {
	const { spec, legacyKey } = withLegacyCompactionThreshold(inputs);

	if (spec.kind === "tokens") {
		// The ceiling for an absolute amount is the AUTO threshold (window minus
		// reserve), not the window itself. A trigger that sits inside the reserve
		// can never fire: a request large enough to push the context that high is
		// refused or overflows before the pre-turn check gets a look, so capping at
		// `contextWindow - 1` honored the operator's number by turning proactive
		// compaction off and leaving error-driven recovery to do the work. Capping
		// at the auto point keeps the amount as large as this model can reach.
		//
		// `clampLow`, not `clamp`: a degenerate window inverts the range (low 1,
		// high 0) and the LOW bound has to win, because a threshold of zero or less
		// is above every possible context size and would compact on every single
		// turn. The two helpers agree everywhere else. Non-finite and non-positive
		// amounts never arrive here at all (`parseCompactionThreshold` sends them to
		// auto), so the helper's own non-finite guard is defence in depth rather
		// than the live path.
		const ceiling = clampLow(autoTokens(), 1, contextWindow - 1);
		const tokens = clampLow(Math.min(spec.tokens, ceiling), 1, contextWindow - 1);
		// Strict `>`: at equality nothing was taken away, and the notice callers
		// word around this flag would be false.
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

/** Round a token count the way the status line does, for notice text. */
function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return String(tokens);
}

/** One-line description of a resolved threshold, including its origin, for every */
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
	/** How compaction reduces the context: summarize in place, or hand off to a */
	strategy?: "handoff" | "summary";
	/** The compaction trigger, unit included: `auto`, `85%`, or `170000`. The one */
	threshold?: string;
	/** Retired; read only by the migration in {@link withLegacyCompactionThreshold}. */
	thresholdPercent?: number;
	/** Retired; read only by the migration in {@link withLegacyCompactionThreshold}. */
	thresholdTokens?: number;
	midTurnEnabled?: boolean;
	/** Tokens reserved below the context window for the next prompt + response. */
	reserveTokens?: number;
	keepRecentTokens: number;
	autoContinue?: boolean;
	/** Optional summarizer endpoint. This is still the `summary` strategy — the */
	remoteEndpoint?: string;
}

/** Reserve applied when {@link CompactionSettings.reserveTokens} is unset. */
export const DEFAULT_RESERVE_TOKENS = 16384;

// reserveTokens is deliberately absent: an unset reserve is what marks it as
// defaulted, which resolveBudgetReserveTokens needs to distinguish "user never
// chose a reserve" from "user explicitly configured the default value".
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

/** Effective reserve: at least 15% of context window or the configured floor */
export function effectiveReserveTokens(contextWindow: number, settings: CompactionSettings): number {
	return Math.max(Math.floor(contextWindow * 0.15), settings.reserveTokens ?? DEFAULT_RESERVE_TOKENS);
}

/** Reserve used when deciding whether a prompt still fits inside the model window. */
export function resolveBudgetReserveTokens(contextWindow: number, settings: CompactionSettings): number {
	const reserveTokens = effectiveReserveTokens(contextWindow, settings);
	const proportionalReserveTokens = Math.max(1, Math.floor(contextWindow * 0.15));
	const reserveWasDefaulted = settings.reserveTokens === undefined;
	const defaultReserveIsEffectivelyImpossible =
		reserveWasDefaulted && reserveTokens >= contextWindow - proportionalReserveTokens;
	const reserveExceedsWindow = reserveTokens >= contextWindow;

	return defaultReserveIsEffectivelyImpossible || reserveExceedsWindow ? proportionalReserveTokens : reserveTokens;
}

/** Check if compaction should trigger based on context usage. */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	// `enabled` is the only off switch. The `strategy === "off"` clause that also
	// stood here was the second one, and two fields that can each disable a
	// feature can disagree about whether it is disabled.
	if (!settings.enabled || contextWindow <= 0) return false;
	const thresholdTokens = resolveThresholdTokens(contextWindow, settings);
	return contextTokens > thresholdTokens;
}

/** Resolve the compaction trigger for a window, with its provenance. */
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

/** Context tokens above which compaction triggers. See {@link resolveThresholdWithOrigin}. */
export function resolveThresholdTokens(contextWindow: number, settings: CompactionSettings): number {
	return resolveThresholdWithOrigin(contextWindow, settings).tokens;
}

/** True when the operator configured an absolute token threshold larger than this */
export function isThresholdTokensClampedForWindow(contextWindow: number, settings: CompactionSettings): boolean {
	const resolved = resolveThresholdWithOrigin(contextWindow, settings);
	return resolved.origin === "tokens" && resolved.clamped;
}
