import type { SymbolTheme } from "../symbols";
import { getSegmenter, replaceTabs, visibleWidth } from "../utils";
import type { SelectListLayoutOptions, SelectListTheme } from "./select-list";

export const AUTOCOMPLETE_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	overflowSearch: false,
};
export const SLASH_COMMAND_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
	overflowSearch: false,
};
export function sanitizeLoadedText(text: string): string {
	return replaceTabs(text.replace(/\r\n?/g, "\n")).replace(/[\x00-\x09\x0b-\x1f]/g, "");
}
export const segmenter = getSegmenter();
export interface TextChunk {
	text: string;
	startIndex: number;
	endIndex: number;
}
export function visualColAtOffset(text: string, offset: number): number {
	if (offset <= 0) return 0;
	let col = 0;
	for (const seg of segmenter.segment(text)) {
		if (seg.index >= offset) break;
		col += visibleWidth(seg.segment);
	}
	return col;
}
export function offsetAtVisualCol(text: string, col: number): number {
	if (col <= 0) return 0;
	let current = 0;
	for (const seg of segmenter.segment(text)) {
		const width = visibleWidth(seg.segment);
		if (current + width > col) return seg.index;
		current += width;
	}
	return text.length;
}
export function maxSegmentVisualCol(text: string, isLastSegment: boolean): number {
	let total = 0;
	let lastWidth = 0;
	for (const seg of segmenter.segment(text)) {
		lastWidth = visibleWidth(seg.segment);
		total += lastWidth;
	}
	return isLastSegment ? total : Math.max(0, total - lastWidth);
}
export const DEFAULT_PAGE_SCROLL_LINES = 10;
export const MAX_UNDO_STACK = 100;
export interface EditorState {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}
export interface LayoutLine {
	text: string;
	hasCursor: boolean;
	cursorPos?: number;
}
export interface EditorTheme {
	borderColor: (str: string) => string;
	selectList: SelectListTheme;
	symbols: SymbolTheme;
	editorPaddingX?: number;
	hintStyle?: (text: string) => string;
}
export interface HistoryEntry {
	prompt: string;
}
export interface HistoryStorage {
	add(prompt: string, cwd?: string): Promise<void>;
	getRecent(limit: number): HistoryEntry[];
}
export type HistoryCursorAnchor = "start" | "end";
