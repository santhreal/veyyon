/**
 * Shared box-drawing chrome for floating overlays. Sharp `theme.boxSharp`
 * glyphs painted in brand silver (`borderAccent`) — never muddy `border`
 * gray hairlines, never sun/ember. ModalShell and these helpers share one
 * structural color so every card reads as Veyyon, not a gray clone.
 *
 * Every helper takes its theme as the last parameter. The module singleton is
 * uninitialised outside a running TUI, and these surfaces render from unit tests
 * and from `ui.custom` extension components, which are handed a theme rather than
 * resolving one.
 */
import { padding, truncateToWidth, visibleWidth } from "@veyyon/tui";
import type { ThemeColor } from "../theme/color";
import type { Theme } from "../theme/theme";

/** Pad or truncate a (possibly ANSI-styled) string to exactly `width` columns. */
export function fit(text: string, width: number): string {
	if (width <= 0) return "";
	const w = visibleWidth(text);
	if (w === width) return text;
	if (w < width) return text + padding(width - w);
	const cut = truncateToWidth(text, width);
	const cw = visibleWidth(cut);
	return cw < width ? cut + padding(width - cw) : cut;
}

/** Structural chrome — silver (`borderAccent`), not dim gray `border`. */
function paint(theme: Theme, s: string): string {
	return theme.fg("borderAccent", s);
}

/** Top border with an optional accent-colored title inset into the rule. */
export function topBorder(width: number, title: string, theme: Theme): string {
	const box = theme.boxSharp;
	const inner = Math.max(0, width - 2);
	if (!title) return paint(theme, box.topLeft + box.horizontal.repeat(inner) + box.topRight);
	const shown = truncateToWidth(` ${title} `, Math.max(0, inner - 2));
	const fillWidth = Math.max(0, inner - 1 - visibleWidth(shown));
	return (
		paint(theme, box.topLeft + box.horizontal) +
		theme.bold(theme.fg("accent", shown)) +
		paint(theme, box.horizontal.repeat(fillWidth) + box.topRight)
	);
}

/** A horizontal rule with left/right tees, splitting overlay sections. */
export function divider(width: number, theme: Theme): string {
	const box = theme.boxSharp;
	return paint(theme, box.teeRight + box.horizontal.repeat(Math.max(0, width - 2)) + box.teeLeft);
}

export function bottomBorder(width: number, theme: Theme): string {
	const box = theme.boxSharp;
	return paint(theme, box.bottomLeft + box.horizontal.repeat(Math.max(0, width - 2)) + box.bottomRight);
}

/** Wrap pre-styled content in vertical borders with single-column insets. */
export function row(content: string, width: number, theme: Theme): string {
	const bar = paint(theme, theme.boxSharp.vertical);
	return `${bar} ${fit(content, Math.max(0, width - 4))} ${bar}`;
}

/**
 * One measurement in a {@link statStrip}: what it is, what it reads, and the tone
 * the reading carries.
 */
export interface StatCell {
	readonly label: string;
	readonly value: string;
	/** Tone for the value. The label is always dim. Defaults to `text`. */
	readonly tone?: ThemeColor;
}

/** Separator between two cells on the same strip row, and the columns it occupies. */
const STAT_SEPARATOR = "  ·  ";
const STAT_SEPARATOR_WIDTH = visibleWidth(STAT_SEPARATOR);

/**
 * A run of `label value` readings on as few rows as they fit in, replacing a
 * column of `Label: value` prose lines.
 *
 * Four readings down the left edge is four rows the eye reads one at a time, and
 * the autoresearch overlay spent five of them on a summary that says less than the
 * table under it. One strip says the same thing in one row and leaves the vertical
 * space to the rows that carry data.
 *
 * A cell is never split: one that does not fit the remainder of a row opens the
 * next one, and a cell wider than the whole strip is truncated rather than wrapped,
 * because half a number on the following row reads as a second reading.
 */
export function statStrip(cells: readonly StatCell[], width: number, theme: Theme): string[] {
	if (cells.length === 0 || width <= 0) return [];
	const rendered = cells.map(cell => `${theme.fg("dim", cell.label)} ${theme.fg(cell.tone ?? "text", cell.value)}`);
	const plain = cells.map(cell => `${cell.label} ${cell.value}`);
	// `border`, not `borderMuted`: at 1600x1000 on the default ground the muted tone
	// puts the dot below the threshold the glyph needs to read at all, and a strip of
	// readings separated by invisible dots is a strip separated by nothing.
	const separator = theme.fg("border", STAT_SEPARATOR);
	const rows: string[] = [];
	let row = "";
	let rowWidth = 0;
	for (const [index, piece] of rendered.entries()) {
		// Display columns, not UTF-16 units: a wide glyph in a label counts twice
		// on screen and the row it opens would otherwise overflow the frame.
		const pieceWidth = visibleWidth(plain[index]);
		if (row === "") {
			row = piece;
			rowWidth = pieceWidth;
			continue;
		}
		if (rowWidth + STAT_SEPARATOR_WIDTH + pieceWidth > width) {
			rows.push(row);
			row = piece;
			rowWidth = pieceWidth;
			continue;
		}
		row += separator + piece;
		rowWidth += STAT_SEPARATOR_WIDTH + pieceWidth;
	}
	rows.push(row);
	return rows.map(line => truncateToWidth(line, width));
}
