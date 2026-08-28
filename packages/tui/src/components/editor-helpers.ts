import type { SymbolTheme } from "../symbols";
import { getSegmenter, getWordNavKind, replaceTabs, visibleWidth } from "../utils";
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
export function wordWrapLine(line: string, maxWidth: number): TextChunk[] {
	if (!line || maxWidth <= 0) {
		return [{ text: "", startIndex: 0, endIndex: 0 }];
	}

	const lineWidth = visibleWidth(line);
	if (lineWidth <= maxWidth) {
		return [{ text: line, startIndex: 0, endIndex: line.length }];
	}

	const chunks: TextChunk[] = [];

	const tokens: { text: string; startIndex: number; endIndex: number; isWhitespace: boolean }[] = [];
	let currentToken = "";
	let tokenStart = 0;
	let inWhitespace = false;
	let charIndex = 0;

	for (const seg of segmenter.segment(line)) {
		const grapheme = seg.segment;
		const graphemeIsWhitespace = getWordNavKind(grapheme) === "whitespace";

		if (currentToken === "") {
			inWhitespace = graphemeIsWhitespace;
			tokenStart = charIndex;
		} else if (graphemeIsWhitespace !== inWhitespace) {
			tokens.push({
				text: currentToken,
				startIndex: tokenStart,
				endIndex: charIndex,
				isWhitespace: inWhitespace,
			});
			currentToken = "";
			tokenStart = charIndex;
			inWhitespace = graphemeIsWhitespace;
		}

		currentToken += grapheme;
		charIndex += grapheme.length;
	}

	if (currentToken) {
		tokens.push({
			text: currentToken,
			startIndex: tokenStart,
			endIndex: charIndex,
			isWhitespace: inWhitespace,
		});
	}

	let currentChunk = "";
	let currentWidth = 0;
	let chunkStartIndex = 0;
	let atLineStart = true; // Track if we're at the start of a line (for skipping whitespace)

	function consumePrefixToWidth(text: string, availableWidth: number): { text: string; len: number } {
		let prefix = "";
		let prefixWidth = 0;
		let len = 0;
		for (const seg of segmenter.segment(text)) {
			const grapheme = seg.segment;
			const graphemeWidth = visibleWidth(grapheme);
			if (prefixWidth + graphemeWidth > availableWidth) break;
			prefix += grapheme;
			prefixWidth += graphemeWidth;
			len += grapheme.length;
			if (prefixWidth === availableWidth) break;
		}
		return { text: prefix, len };
	}
	function hasWideGrapheme(text: string): boolean {
		for (const seg of segmenter.segment(text)) {
			if (visibleWidth(seg.segment) > 1) return true;
		}
		return false;
	}
	for (let ti = 0; ti < tokens.length; ti++) {
		const token = tokens[ti]!;
		const tokenWidth = visibleWidth(token.text);

		if (atLineStart && token.isWhitespace) {
			const prev = chunks[chunks.length - 1];
			if (prev) prev.endIndex = token.endIndex;
			chunkStartIndex = token.endIndex;
			continue;
		}
		atLineStart = false;

		if (tokenWidth > maxWidth) {
			let consumedPrefix = "";
			let consumedPrefixLen = 0; // JS string index (code units) consumed from token.text
			if (currentChunk && currentWidth < maxWidth) {
				const remainingWidth = maxWidth - currentWidth;
				const consumed = consumePrefixToWidth(token.text, remainingWidth);
				consumedPrefix = consumed.text;
				consumedPrefixLen = consumed.len;
			}
			if (currentChunk) {
				if (consumedPrefix) {
					chunks.push({
						text: currentChunk + consumedPrefix,
						startIndex: chunkStartIndex,
						endIndex: token.startIndex + consumedPrefixLen,
					});
					currentChunk = "";
					currentWidth = 0;
					chunkStartIndex = token.startIndex + consumedPrefixLen;
				} else {
					chunks.push({
						text: currentChunk,
						startIndex: chunkStartIndex,
						endIndex: token.startIndex,
					});
					currentChunk = "";
					currentWidth = 0;
					chunkStartIndex = token.startIndex;
				}
			}
			const remainingText = consumedPrefixLen > 0 ? token.text.slice(consumedPrefixLen) : token.text;
			let tokenChunk = "";
			let tokenChunkWidth = 0;
			let tokenChunkStart = token.startIndex + consumedPrefixLen;
			let tokenCharIndex = token.startIndex + consumedPrefixLen;
			for (const seg of segmenter.segment(remainingText)) {
				const grapheme = seg.segment;
				const graphemeWidth = visibleWidth(grapheme);
				if (tokenChunkWidth + graphemeWidth > maxWidth && tokenChunk) {
					chunks.push({
						text: tokenChunk,
						startIndex: tokenChunkStart,
						endIndex: tokenCharIndex,
					});
					tokenChunk = grapheme;
					tokenChunkWidth = graphemeWidth;
					tokenChunkStart = tokenCharIndex;
				} else {
					tokenChunk += grapheme;
					tokenChunkWidth += graphemeWidth;
				}
				tokenCharIndex += grapheme.length;
			}
			if (tokenChunk) {
				currentChunk = tokenChunk;
				currentWidth = tokenChunkWidth;
				chunkStartIndex = tokenChunkStart;
			}
			continue;
		}

		if (currentWidth + tokenWidth > maxWidth) {
			if (currentChunk && !token.isWhitespace && currentWidth < maxWidth && hasWideGrapheme(token.text)) {
				const remainingWidth = maxWidth - currentWidth;
				const consumed = consumePrefixToWidth(token.text, remainingWidth);
				if (consumed.text) {
					chunks.push({
						text: currentChunk + consumed.text,
						startIndex: chunkStartIndex,
						endIndex: token.startIndex + consumed.len,
					});
					const remainder = token.text.slice(consumed.len);
					currentChunk = remainder;
					currentWidth = visibleWidth(remainder);
					chunkStartIndex = token.startIndex + consumed.len;
					atLineStart = false;
					continue;
				}
			}
			const trimmedChunk = currentChunk.trimEnd();
			if (trimmedChunk || chunks.length === 0) {
				chunks.push({
					text: trimmedChunk,
					startIndex: chunkStartIndex,
					endIndex: chunkStartIndex + currentChunk.length,
				});
			} else {
				const prev = chunks[chunks.length - 1];
				if (prev) prev.endIndex = chunkStartIndex + currentChunk.length;
			}
			atLineStart = true;
			if (token.isWhitespace) {
				const prev = chunks[chunks.length - 1];
				if (prev) prev.endIndex = token.endIndex;
				currentChunk = "";
				currentWidth = 0;
				chunkStartIndex = token.endIndex;
			} else {
				currentChunk = token.text;
				currentWidth = tokenWidth;
				chunkStartIndex = token.startIndex;
				atLineStart = false;
			}
		} else {
			currentChunk += token.text;
			currentWidth += tokenWidth;
		}
	}

	if (currentChunk) {
		chunks.push({
			text: currentChunk,
			startIndex: chunkStartIndex,
			endIndex: line.length,
		});
	}

	return chunks.length > 0 ? chunks : [{ text: "", startIndex: 0, endIndex: 0 }];
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
