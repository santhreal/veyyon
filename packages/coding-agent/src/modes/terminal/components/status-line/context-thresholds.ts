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

import { formatNumber } from "@veyyon/utils/format";
import type { ThemeColor } from "../../../../theme/color";

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

/** Tokens still available before the limit, never negative: `153k left`. */
export function formatContextRemaining(usedTokens: number, limitTokens: number): string {
	if (!Number.isFinite(limitTokens) || limitTokens <= 0) return "? left";
	const used = Number.isFinite(usedTokens) && usedTokens > 0 ? usedTokens : 0;
	return `${formatNumber(Math.max(0, Math.round(limitTokens - used)))} left`;
}

/**
 * The width every percentage state is padded to: the widest member, `100%`.
 *
 * This segment sits at the right end of a justified row, so a column the text
 * gains is a column the gap loses and the whole right-hand group slides. The
 * launch card renders the gauge before any count exists and the session
 * replaces that reading about half a second later, which moved the row under a
 * composer that had already been drawn; `9%` to `10%` and `99%` to `100%` did
 * the same thing mid-session. At one width a value arriving or changing
 * repaints in place.
 */
const PERCENT_FIELD_COLS = "100%".length;

/**
 * The percentage still available, as a whole number in a fixed-width field:
 * ` 76% left`, `   ? left`, `100% left`.
 *
 * Whole numbers only. A tenth of a percent decides nothing and moved on every
 * turn, so the digit was jitter on the one surface users already called
 * confusing. The word is part of the string because `76%` beside a gauge is
 * read as consumption by default, and that ambiguity is the bug.
 */
export function formatContextRemainingPercent(usedPercent: number | null | undefined): string {
	const field =
		usedPercent === null || usedPercent === undefined || !Number.isFinite(usedPercent)
			? "?"
			: `${Math.max(0, Math.min(100, Math.round(100 - usedPercent)))}%`;
	return `${field.padStart(PERCENT_FIELD_COLS)} left`;
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
