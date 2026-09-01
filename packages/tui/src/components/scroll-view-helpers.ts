import { type Ellipsis, visibleWidth } from "../utils";

export const DEFAULT_TRACK = "│";
export const DEFAULT_THUMB = "█";

export type ScrollbarMode = "auto" | "always" | "never";

export interface ScrollViewTheme {
	track?: (text: string) => string;
	thumb?: (text: string) => string;
}

export interface ScrollViewOptions {
	height: number;
	scrollbar?: ScrollbarMode | boolean;
	totalRows?: number;
	theme?: ScrollViewTheme;
	trackChar?: string;
	thumbChar?: string;
	ellipsis?: Ellipsis;
	fastScrollLines?: number;
}

export function normalizeScrollbarMode(scrollbar: ScrollViewOptions["scrollbar"]): ScrollbarMode {
	if (scrollbar === true) return "auto";
	if (scrollbar === false) return "never";
	return scrollbar ?? "auto";
}

export function firstCellGlyph(value: string, fallback: string): string {
	const glyph = Array.from(value)[0] ?? fallback;
	return visibleWidth(glyph) === 1 ? glyph : fallback;
}
