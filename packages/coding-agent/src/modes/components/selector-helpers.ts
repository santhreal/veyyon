import { clampLow, Ellipsis, extractPrintableText, matchesKey, ScrollView, truncateToWidth } from "@veyyon/tui";
import type { ThemeBg } from "../theme/theme";
import { paintBand, theme } from "../theme/theme";

export const SCROLL_LIST_THEME = {
	track: (t: string) => theme.fg("muted", t),
	thumb: (t: string) => theme.fg("accent", t),
};

export function selectionBand(line: string, rowWidth: number, background: ThemeBg = "selectedBg"): string {
	return paintBand(truncateToWidth(line, rowWidth, Ellipsis.Omit, true), background, 1);
}

export function hoverBandAt(line: string, rowWidth: number, strength: number): string {
	return paintBand(truncateToWidth(line, rowWidth, Ellipsis.Omit, true), "selectedBg", strength);
}

export function renderScrollableList(
	options: { width: number; visibleRows: number; totalRows: number; scrollOffset: number },
	buildRows: (rowWidth: number) => readonly string[],
): readonly string[] {
	const sv = new ScrollView([], {
		height: options.visibleRows,
		scrollbar: "auto",
		totalRows: options.totalRows,
		theme: SCROLL_LIST_THEME,
	});
	sv.setLines(buildRows(sv.contentWidth(options.width)));
	sv.setScrollOffset(options.scrollOffset);
	return sv.render(options.width);
}

export function centeredWindow(
	selectedIndex: number,
	total: number,
	maxVisible: number,
): { startIndex: number; endIndex: number } {
	const startIndex = clampLow(selectedIndex - Math.floor(maxVisible / 2), 0, total - maxVisible);
	const endIndex = Math.min(startIndex + maxVisible, total);
	return { startIndex, endIndex };
}

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
