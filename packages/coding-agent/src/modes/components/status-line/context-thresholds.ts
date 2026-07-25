/**
 * The context gauge's numbers and colors, in one place.
 *
 * The gauge answers exactly one question: how much room is left before the
 * context runs out. "Runs out" means whichever comes first — auto-compaction
 * firing, or the model's window filling when auto-compaction is off — and that
 * number is the LIMIT here. It is not always the model's window, so the two are
 * never conflated: see {@link SegmentContext.contextLimit} against
 * {@link SegmentContext.contextWindow}.
 */

import { formatNumber } from "@veyyon/utils";
import type { ThemeColor } from "../../../modes/theme/theme";

export type ContextUsageLevel = "normal" | "warning" | "high" | "error";

/**
 * One ladder, measured in percent of the limit. There used to be a second,
 * hidden ladder of absolute token counts (150k/270k/500k) folded in with
 * `Math.min`, which meant a 1M-window session went yellow at 15% and red at
 * 50%: the color contradicted the number printed beside it. The thresholds were
 * calibrated for a ~300k window and were quietly wrong at every other size, so
 * the second axis is gone. Length-related quality effects belong to the model
 * catalog, not to a color ramp that lies about the percentage next to it.
 */
const CONTEXT_WARNING_PERCENT_THRESHOLD = 50;
const CONTEXT_HIGH_PERCENT_THRESHOLD = 70;
const CONTEXT_ERROR_PERCENT_THRESHOLD = 90;

/**
 * The heat of the gauge, from the used percentage of the limit. `null`/unknown
 * usage is `normal`: an unknown number must not paint an alarm.
 */
export function getContextUsageLevel(usedPercent: number | null | undefined): ContextUsageLevel {
	if (usedPercent === null || usedPercent === undefined || !Number.isFinite(usedPercent)) return "normal";
	if (usedPercent >= CONTEXT_ERROR_PERCENT_THRESHOLD) return "error";
	if (usedPercent >= CONTEXT_HIGH_PERCENT_THRESHOLD) return "high";
	if (usedPercent >= CONTEXT_WARNING_PERCENT_THRESHOLD) return "warning";
	return "normal";
}

/**
 * Tokens used against the limit, one unit on both sides: `47k/200k`.
 *
 * It used to render `47.3%/200,000` — a percent and a token count either side
 * of a slash, a notation that everywhere else means a ratio of like quantities,
 * with no reading of it that is arithmetically true. An unknown limit is `47k/?`
 * rather than `47k/0`, because a zero denominator reads as a real number.
 */
export function formatContextUsage(usedTokens: number, limitTokens: number): string {
	const used = Number.isFinite(usedTokens) && usedTokens > 0 ? usedTokens : 0;
	if (!Number.isFinite(limitTokens) || limitTokens <= 0) return `${formatNumber(used)}/?`;
	return `${formatNumber(used)}/${formatNumber(limitTokens)}`;
}

/** Tokens still available before the limit, never negative: `153k left`. */
export function formatContextRemaining(usedTokens: number, limitTokens: number): string {
	if (!Number.isFinite(limitTokens) || limitTokens <= 0) return "? left";
	const used = Number.isFinite(usedTokens) && usedTokens > 0 ? usedTokens : 0;
	return `${formatNumber(Math.max(0, Math.round(limitTokens - used)))} left`;
}

/**
 * The percentage still available, as a whole number: `76% left`.
 *
 * Whole numbers only. A tenth of a percent decides nothing and moved on every
 * turn, so the digit was jitter on the one surface users already called
 * confusing. The word is part of the string because `76%` beside a gauge is
 * read as consumption by default, and that ambiguity is the bug.
 */
export function formatContextRemainingPercent(usedPercent: number | null | undefined): string {
	if (usedPercent === null || usedPercent === undefined || !Number.isFinite(usedPercent)) return "? left";
	return `${Math.max(0, Math.min(100, Math.round(100 - usedPercent)))}% left`;
}

export function getContextUsageThemeColor(level: ContextUsageLevel): ThemeColor {
	switch (level) {
		case "error":
			return "error";
		case "high":
			return "thinkingHigh";
		case "warning":
			return "warning";
		case "normal":
			return "statusLineContext";
	}
}
