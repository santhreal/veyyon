import { theme } from "../../modes/theme/theme";
import { COMPOSER_INSET_COLS } from "./composer-chrome";

/** Cells of rule drawn to the LEFT of a transcript divider's label. A divider marks a point in the conversation, not a section of chrome, so it */
export const TRANSCRIPT_DIVIDER_RULE_WIDTH = 10;

/** One transcript divider row, on the transcript's rail: ────────── 📷 compacted · ctrl+o */
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
