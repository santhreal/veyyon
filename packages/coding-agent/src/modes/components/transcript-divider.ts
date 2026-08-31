import { theme } from "../../modes/theme/theme";
import { COMPOSER_INSET_COLS } from "./composer-chrome";

/**
 * Cells of rule drawn to the LEFT of a transcript divider's label.
 *
 * A divider marks a point in the conversation, not a section of chrome, so it
 * is a short mark on the transcript's own left edge rather than a rule spanning
 * the viewport. A full-bleed rule reads as a page break shouting over the two
 * lines it sits between, and the transcript already carries one left rail: a
 * second full-width horizontal only competes with it.
 */
export const TRANSCRIPT_DIVIDER_RULE_WIDTH = 10;

/**
 * One transcript divider row, on the transcript's rail:
 *
 *     ────────── 📷 compacted · ctrl+o
 *
 * `label` is the event (already carrying its icon); `hint` is the key that
 * opens whatever the divider hides, and is omitted for a divider with nothing
 * behind it. Both are pre-styled by the caller only in the sense that a label
 * may embed its own color for a badge — the divider paints the rule dim, the
 * label muted, and the hint dim.
 *
 * The row opens at `COMPOSER_INSET_COLS`, the gutter every other transcript
 * block starts at, because a divider is a block like any other. It only sat at
 * column zero while it spanned the viewport, where there was no choice.
 *
 * Too narrow to draw even one cell of rule beside the label, the row degrades
 * to the bare label: the mark is decoration and the words are the content.
 */
export function renderTranscriptDivider(width: number, label: string, hint?: string): string {
	// sep.dot ships pre-padded (" · "); trim so a bound hint joins with single spaces.
	const dot = theme.sep.dot.trim();
	const tail = hint ? `${dot} ${hint}` : "";
	const content = tail ? `${label} ${tail}` : label;
	const contentWidth = Bun.stringWidth(content, { countAnsiEscapeCodes: false });
	const inset = " ".repeat(COMPOSER_INSET_COLS);
	const ruleWidth = Math.min(TRANSCRIPT_DIVIDER_RULE_WIDTH, width - COMPOSER_INSET_COLS - contentWidth - 1);
	const styled = tail ? `${theme.fg("muted", label)} ${theme.fg("dim", tail)}` : theme.fg("muted", label);
	if (ruleWidth < 1) return `${inset}${styled}`;
	return `${inset}${theme.fg("dim", theme.tree.horizontal.repeat(ruleWidth))} ${styled}`;
}
