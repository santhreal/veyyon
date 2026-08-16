/**
 * Shared scaffolding for the TUI selector/list/dashboard components: viewport
 * windowing, scrollbar-aware row widths, ScrollView rendering, selection
 * clamping, search-character classification, tab-cycling keys, and full-screen
 * padding. Behaviour is identical to the per-component copies these helpers
 * replace.
 */
import { clampLow, Ellipsis, extractPrintableText, matchesKey, ScrollView, truncateToWidth } from "@veyyon/tui";
import type { ThemeBg } from "../theme/theme";
import { hoverBand, theme } from "../theme/theme";

/**
 * Paint `line` as a selection or hover band that fills the whole row.
 *
 * A band is a property of the ROW, not of the text in it. Tinting the text
 * alone leaves the highlight ending wherever that row's content happened to
 * stop, so the band changes shape as the cursor moves and reads as a rendering
 * fault. The row is padded to `rowWidth` first and only then tinted, which also
 * keeps the closing escape inside the width the list will render at.
 */
export function selectionBand(line: string, rowWidth: number, background: ThemeBg = "selectedBg"): string {
	return theme.bg(background, truncateToWidth(line, rowWidth, Ellipsis.Omit, true));
}

/**
 * Paint `line` as a pointer band at `strength`, the fading sibling of
 * {@link selectionBand}.
 *
 * At strength 1 this IS `selectionBand(line, rowWidth)`, byte for byte: a list
 * whose pointer band does not fade paints the same row it always did. Below it
 * the theme mixes the band out of the ground the row sits on, so the band
 * arrives from the page instead of appearing on it. What a strength LOOKS like
 * is the theme's decision ({@link hoverBand}); a list only decides when a row is
 * at what strength, and only calls this for a strength above 0 — the band at 0
 * is the absence of a band, not a band mixed all the way out.
 */
export function hoverBandAt(line: string, rowWidth: number, strength: number): string {
	return hoverBand(truncateToWidth(line, rowWidth, Ellipsis.Omit, true), strength);
}

/**
 * Render a windowed list through a {@link ScrollView} with the shared list theme
 * (muted track / accent thumb) and an "auto" scrollbar, positioned at
 * `scrollOffset`. Returns the rendered lines for the caller to append.
 *
 * `buildRows` is handed the width its rows may actually occupy and must return
 * exactly `visibleRows` of them. It is a callback rather than a finished array
 * because that width is the ScrollView's own rule: the bar takes two columns,
 * a gutter and the glyph, and a caller that computed the reserve itself was
 * wrong by one. Rows built one column too wide are truncated on the way out,
 * and a truncation that lands inside a background fill drops the escape that
 * CLOSES it, so a selected row bleeds its colour across the scrollbar.
 */
export function renderScrollableList(
	options: { width: number; visibleRows: number; totalRows: number; scrollOffset: number },
	buildRows: (rowWidth: number) => readonly string[],
): readonly string[] {
	const sv = new ScrollView([], {
		height: options.visibleRows,
		scrollbar: "auto",
		totalRows: options.totalRows,
		theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
	});
	sv.setLines(buildRows(sv.contentWidth(options.width)));
	sv.setScrollOffset(options.scrollOffset);
	return sv.render(options.width);
}

/**
 * Center a viewport window of `maxVisible` rows on `selectedIndex` within a
 * list of `total` rows, clamped to valid bounds. Used by the selection-centered
 * list panes (history search, tree selector).
 */
export function centeredWindow(
	selectedIndex: number,
	total: number,
	maxVisible: number,
): { startIndex: number; endIndex: number } {
	const startIndex = clampLow(selectedIndex - Math.floor(maxVisible / 2), 0, total - maxVisible);
	const endIndex = Math.min(startIndex + maxVisible, total);
	return { startIndex, endIndex };
}

/**
 * Clamp `selectedIndex` into `[0, total)` and nudge `scrollOffset` so the
 * selection stays within the visible window of `maxVisible` rows. Returns the
 * adjusted pair; on an empty list both reset to 0.
 */
export function clampSelection(
	selectedIndex: number,
	scrollOffset: number,
	total: number,
	maxVisible: number,
): { selectedIndex: number; scrollOffset: number } {
	if (total === 0) {
		return { selectedIndex: 0, scrollOffset: 0 };
	}

	const selected = clampLow(selectedIndex, 0, total - 1);

	let scroll = scrollOffset;
	if (selected < scroll) {
		scroll = selected;
	} else if (selected >= scroll + maxVisible) {
		scroll = selected - maxVisible + 1;
	}

	return { selectedIndex: selected, scrollOffset: scroll };
}

/**
 * Classify a key event for search-query text entry. Returns the single
 * printable character to append to the query, or `null` when the key is not a
 * searchable character: non-printable, multi-byte, or a reserved `j`/`k`
 * navigation key.
 */
export function searchableChar(data: string): string | null {
	const printableText = extractPrintableText(data);
	if (printableText && printableText.length === 1) {
		const printableCharCode = printableText.charCodeAt(0);
		if (printableCharCode > 32 && printableCharCode < 127) {
			if (printableText === "j" || printableText === "k") {
				return null;
			}
			return printableText;
		}
	}
	return null;
}

/**
 * Handle the shared tab-cycling keys: Tab/Right advance to the next tab,
 * Shift+Tab/Left to the previous. Invokes `switchTab` with the direction and
 * returns true when the key was consumed.
 */
export function handleTabSwitchKey(data: string, switchTab: (direction: 1 | -1) => void): boolean {
	if (matchesKey(data, "tab") || matchesKey(data, "right")) {
		switchTab(1);
		return true;
	}
	if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
		switchTab(-1);
		return true;
	}
	return false;
}

/**
 * Pad `lines` with blank rows up to `rows` so a full-screen overlay covers the
 * viewport instead of letting the transcript peek through below it. Copies
 * before padding — the source array may be component-owned and must not be
 * mutated.
 */
export function padLinesToHeight(lines: readonly string[], rows: number): readonly string[] {
	if (lines.length >= rows) return lines;
	const padded = lines.slice();
	while (padded.length < rows) padded.push("");
	return padded;
}
