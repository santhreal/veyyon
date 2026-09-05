import { SUB_CELL_BAR_RAMP, subCellBar } from "@veyyon/utils/bar";
import { clamp01 } from "@veyyon/utils/math";
import { truncateToWidth, visibleWidth } from "@veyyon/utils/width";
import { shimmerText } from "../../theme/shimmer";
import { theme as currentTheme, type Theme } from "../../theme/theme";

type ProgressBarTheme = Pick<Theme, "bold" | "fg" | "getFgAnsi">;

const unstyledProgressBarTheme: ProgressBarTheme = {
	fg(_color, text) {
		return text;
	},
	bold(text) {
		return text;
	},
	getFgAnsi() {
		return "";
	},
};

function resolveProgressBarTheme(uiTheme: ProgressBarTheme | undefined): ProgressBarTheme {
	return uiTheme ?? currentTheme ?? unstyledProgressBarTheme;
}

/**
 * Render a progress bar with a trailing percent label.
 * `fraction` is clamped to `[0, 1]`. `undefined` renders a dotted placeholder.
 *
 * The bar is eight steps per column, so 3% of a 24-column bar moves it and a
 * value crossing a column shows the crossing instead of jumping it. The glyphs
 * come from the active symbol preset, which is what keeps an `ascii` terminal
 * off the partial blocks; `uiTheme` is the COLOUR seam and does not carry them,
 * so a caller injecting a bare colour stub still draws the real glyphs.
 */
export function renderAsciiBar(fraction: number | undefined, width = 24, uiTheme?: ProgressBarTheme): string {
	const progressBarTheme = resolveProgressBarTheme(uiTheme);
	if (fraction === undefined) return `[${shimmerText("·".repeat(width), progressBarTheme)}]`;
	const clamped = clamp01(fraction);
	const pct = Math.round(clamped * 100);
	// `typeof` rather than a nullish check: the binding is declared `Theme` and is
	// genuinely unset until a theme is applied (see `fgOrPlain` in theme.ts).
	const ramp = typeof currentTheme === "undefined" ? SUB_CELL_BAR_RAMP : currentTheme.getBarRamp();
	return `[${shimmerText(subCellBar(clamped, width, { ramp }), progressBarTheme)}] ${pct}%`;
}

/**
 * Narrowest column the window label occupies before its bar, so stacked windows line their bars up.
 *
 * Sized for the labels providers ACTUALLY send. Both account surfaces started at 4, which fits the
 * `5h` / `7d` shorthand a fixture invents and nothing a provider returns: Anthropic sends
 * `5 Hour` and `7 Day`, Antigravity `Daily`, Codex `7 days`. At 4 the pad was a no-op, so the bar
 * butted straight against the label (`5 Hour[████░░░░░░]`) and two windows of different label
 * lengths started their bars in different columns.
 */
export const USAGE_WINDOW_LABEL_COLUMN = 8;

/**
 * Longest window label rendered before it is clipped; past this the label would eat the bar.
 *
 * Wide enough for a qualified label (`Daily · Anthropic`), because the qualifier is the ONLY thing
 * telling two bars of one account apart. At 12 the three Antigravity counters clipped to
 * `Daily · Ant…`, `Daily · Goo…`, `Daily · Ope…` — an ellipsis exactly where the identity is.
 */
export const USAGE_WINDOW_LABEL_MAX = 20;

/**
 * The column a group of windows shares, so their bars align without padding a short group out to
 * the maximum. One account's windows are laid out together; two accounts need not agree.
 */
export function usageWindowLabelColumn(labels: readonly string[]): number {
	let widest = 0;
	for (const label of labels) widest = Math.max(widest, visibleWidth(truncateToWidth(label, USAGE_WINDOW_LABEL_MAX)));
	return Math.max(USAGE_WINDOW_LABEL_COLUMN, widest + 1);
}

/**
 * One usage window as both account surfaces print it: `7 Day    [███▍░░░░░░] 34%   resets in 4h`.
 *
 * ONE owner for the layout, because the two surfaces have to agree: they sit next to each other in
 * the same session, and a bar that starts one column further left in `/account` than on the card
 * reads as a rendering bug in whichever one you saw second.
 */
export function formatUsageWindowLine(
	label: string,
	usedFraction: number | undefined,
	barWidth: number,
	resetsSuffix?: string,
	labelColumn: number = USAGE_WINDOW_LABEL_COLUMN,
): string {
	const clipped = truncateToWidth(label, USAGE_WINDOW_LABEL_MAX);
	const padded = clipped + " ".repeat(Math.max(1, labelColumn - visibleWidth(clipped)));
	return `${padded}${renderAsciiBar(usedFraction, barWidth)}${resetsSuffix ?? ""}`;
}
