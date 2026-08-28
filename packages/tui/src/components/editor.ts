import { getProjectDir } from "@veyyon/utils/dirs";
import * as logger from "@veyyon/utils/logger";
import { SGR_BG_RESET } from "../ansi";
import {
	type AutocompleteProvider,
	findLeadingSlashCommandStart,
	findTrailingSlashCommandStart,
	midPromptSkillTokenMatches,
} from "../autocomplete";
import { BracketedPasteHandler, decodeReencodedPasteControls } from "../bracketed-paste";
import { getKeybindings, type KeybindingsManager } from "../keybindings";
import { extractPrintableText, isLoneLineFeed, matchesKey } from "../keys";
import { KillRing } from "../kill-ring";
import { BlockReveal, type BlockRevealOptions } from "../motion-grow";
import type { MouseRoutable, SgrMouseEvent } from "../mouse";
import type { SymbolTheme } from "../symbols";
import { type Component, CURSOR_MARKER, type Focusable } from "../tui";
import {
	clampLow,
	getSegmenter,
	getWordNavKind,
	moveWordLeft,
	moveWordRight,
	padding,
	padLineToWidth,
	reopenBackgroundAfterResets,
	replaceTabs,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
} from "../utils";
import { type SelectItem, SelectList, type SelectListLayoutOptions, type SelectListTheme } from "./select-list";

const AUTOCOMPLETE_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	overflowSearch: false,
};

const SLASH_COMMAND_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
	overflowSearch: false,
};

function sanitizeLoadedText(text: string): string {
	return replaceTabs(text.replace(/\r\n?/g, "\n")).replace(/[\x00-\x09\x0b-\x1f]/g, "");
}

const segmenter = getSegmenter();

interface TextChunk {
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

const DEFAULT_PAGE_SCROLL_LINES = 10;

const MAX_UNDO_STACK = 100;

interface EditorState {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

interface LayoutLine {
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
interface HistoryEntry {
	prompt: string;
}

interface HistoryStorage {
	add(prompt: string, cwd?: string): Promise<void>;
	getRecent(limit: number): HistoryEntry[];
}

type HistoryCursorAnchor = "start" | "end";

export class Editor implements Component, Focusable, MouseRoutable {
	#state: EditorState = {
		lines: [""],
		cursorLine: 0,
		cursorCol: 0,
	};

	focused: boolean = false;

	#theme: EditorTheme;
	#useTerminalCursor = false;

	cursorOverride: string | undefined;
	cursorOverrideWidth: number | undefined;
	decorateText: ((text: string) => string) | undefined;
	#promptGutter: string | undefined;
	#promptGutterContinuation: string | undefined;
	#placeholder: string | undefined;
	#rowBackground: string | undefined;

	#lastLayoutWidth: number = 80;
	#wrapCache = new Map<string, TextChunk[]>();
	#wrapCacheWidth = -1;
	#paddingXOverride: number | undefined;
	#maxHeight?: number;
	#scrollOffset: number = 0;

	#killRing = new KillRing();
	#lastAction: "kill" | "yank" | "type-word" | null = null;

	#jumpMode: "forward" | "backward" | null = null;

	#preferredVisualCol: number | null = null;

	borderColor: (str: string) => string;

	#autocompleteProvider?: AutocompleteProvider;
	#autocompleteList?: SelectList;
	#autocompleteState: "regular" | "force" | null = null;
	#autocompletePrefix: string = "";
	#autocompleteRequestId: number = 0;
	#autocompleteMaxVisible: number = 5;
	#autocompleteReveal?: BlockReveal;
	#autocompleteRowStart = -1;
	#textRowStart = 0;
	#textRowCount = 0;
	#textColStart = 0;
	#textScrollOffset = 0;
	onAutocompleteUpdate?: () => void;

	#pastes: Map<number, string> = new Map();
	#pasteCounter: number = 0;

	atomicTokenPattern: RegExp | undefined;
	#atomicTokenSource: string | undefined;
	#atomicTokenRe: RegExp | undefined;

	#pasteHandler = new BracketedPasteHandler();

	#history: string[] = [];
	#historyIndex: number = -1; // -1 = not browsing, 0 = most recent, 1 = older, etc.
	#historyStorage?: HistoryStorage;

	#undoStack: EditorState[] = [];
	#suspendUndo = false;

	#autocompleteTimeout?: NodeJS.Timeout;

	onSubmit?: (text: string) => void | Promise<void>;
	onAltEnter?: (text: string) => void;
	onChange?: (text: string) => void;
	onLargePaste?: (text: string, lineCount: number) => boolean;
	onAutocompleteCancel?: () => void;
	disableSubmit: boolean = false;

	#borderVisible = true;

	constructor(theme: EditorTheme) {
		this.#theme = theme;
		this.borderColor = theme.borderColor;
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.#autocompleteProvider = provider;
	}

	setBorderVisible(borderVisible: boolean): void {
		this.#borderVisible = borderVisible;
	}

	setPromptGutter(promptGutter: string | undefined): void {
		this.#promptGutter = promptGutter;
	}

	setPromptGutterContinuation(text: string | undefined): void {
		this.#promptGutterContinuation = text;
	}

	setRowBackground(open: string | undefined): void {
		this.#rowBackground = open === "" ? undefined : open;
	}

	setPlaceholder(placeholder: string | undefined): void {
		this.#placeholder = placeholder;
	}

	getTopBorderAvailableWidth(terminalWidth: number): number {
		const paddingX = this.#getEditorPaddingX();
		const borderWidth = this.#getHorizontalChromeWidth(paddingX);
		return Math.max(0, terminalWidth - borderWidth * 2);
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#useTerminalCursor = useTerminalCursor;
	}

	getUseTerminalCursor(): boolean {
		return this.#useTerminalCursor;
	}

	setMaxHeight(maxHeight: number | undefined): void {
		if (this.#maxHeight === maxHeight) return;
		this.#maxHeight = maxHeight;
	}

	setPaddingX(paddingX: number): void {
		this.#paddingXOverride = Math.max(0, paddingX);
	}

	getAutocompleteMaxVisible(): number {
		return this.#autocompleteMaxVisible;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		const newMaxVisible = Number.isFinite(maxVisible) ? clampLow(Math.floor(maxVisible), 3, 20) : 5;
		if (this.#autocompleteMaxVisible !== newMaxVisible) {
			this.#autocompleteMaxVisible = newMaxVisible;
		}
	}

	setAutocompleteMotion(options: BlockRevealOptions): void {
		this.#autocompleteReveal?.disarm();
		this.#autocompleteReveal = new BlockReveal(options);
	}

	disposeAutocompleteMotion(): void {
		this.#autocompleteReveal?.disarm();
		this.#autocompleteReveal = undefined;
	}

	setHistoryStorage(storage: HistoryStorage): void {
		this.#historyStorage = storage;
		const recent = storage.getRecent(100);
		this.#history = recent.map(entry => entry.prompt);
		this.#historyIndex = -1;
	}

	addToHistory(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		if (this.#history.length > 0 && this.#history[0] === trimmed) return;
		this.#history.unshift(trimmed);
		if (this.#history.length > 100) {
			this.#history.pop();
		}

		const stor = this.#historyStorage;
		if (stor) {
			stor.add(trimmed, getProjectDir()).catch(error => {
				logger.error("HistoryStorage add failed", { error: String(error) });
			});
		}
	}

	#isEditorEmpty(): boolean {
		return this.#state.lines.length === 1 && this.#state.lines[0] === "";
	}

	#isOnFirstVisualLine(): boolean {
		const visualLines = this.#buildVisualLineMap(this.#lastLayoutWidth);
		const currentVisualLine = this.#findCurrentVisualLine(visualLines);
		return currentVisualLine === 0;
	}

	#isOnLastVisualLine(): boolean {
		const visualLines = this.#buildVisualLineMap(this.#lastLayoutWidth);
		const currentVisualLine = this.#findCurrentVisualLine(visualLines);
		return currentVisualLine === visualLines.length - 1;
	}

	#navigateHistory(direction: 1 | -1): void {
		this.#resetKillSequence();
		if (this.#history.length === 0) return;
		const newIndex = this.#historyIndex - direction; // Up(-1) increases index, Down(1) decreases
		if (newIndex < -1 || newIndex >= this.#history.length) return;
		this.#historyIndex = newIndex;
		if (this.#historyIndex === -1) {
			this.#setTextInternal("", "end");
		} else {
			const cursorAnchor: HistoryCursorAnchor = direction === -1 ? "start" : "end";
			this.#setTextInternal(this.#history[this.#historyIndex] || "", cursorAnchor);
		}
	}
	#setTextInternal(text: string, cursorAnchor: HistoryCursorAnchor = "end"): void {
		this.#undoStack.length = 0;
		const lines = sanitizeLoadedText(text).split("\n");
		this.#state.lines = lines.length === 0 ? [""] : lines;
		if (cursorAnchor === "start") {
			this.#state.cursorLine = 0;
			this.#setCursorCol(0);
		} else {
			this.#state.cursorLine = this.#state.lines.length - 1;
			this.#setCursorCol(this.#state.lines[this.#state.cursorLine]?.length || 0);
		}
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	invalidate(): void {}

	#getEditorPaddingX(): number {
		const padding = this.#paddingXOverride ?? this.#theme.editorPaddingX ?? 2;
		return Math.max(0, padding);
	}

	#getHorizontalChromeWidth(paddingX: number): number {
		return this.#borderVisible ? paddingX + 1 : 0;
	}

	#getPromptGutterWidth(width: number, paddingX: number): number {
		if (this.#borderVisible || !this.#promptGutter) return 0;
		const chromeWidth = 2 * this.#getHorizontalChromeWidth(paddingX);
		const availableWidth = Math.max(0, width - chromeWidth);
		return Math.min(visibleWidth(this.#promptGutter), availableWidth);
	}

	#getPromptGutter(
		width: number,
		paddingX: number,
	): { firstLine: string; continuation: string; width: number } | undefined {
		if (this.#borderVisible || !this.#promptGutter) return undefined;
		const gutterWidth = this.#getPromptGutterWidth(width, paddingX);
		if (gutterWidth === 0) return undefined;
		const continuationSource = this.#promptGutterContinuation;
		let continuation = padding(gutterWidth);
		if (continuationSource !== undefined) {
			const sliced = sliceByColumn(continuationSource, 0, gutterWidth, true);
			continuation = padLineToWidth(sliced, gutterWidth);
		}
		return {
			firstLine: sliceByColumn(this.#promptGutter, 0, gutterWidth, true),
			continuation,
			width: gutterWidth,
		};
	}

	#getContentWidth(width: number, paddingX: number): number {
		const chromeWidth = 2 * this.#getHorizontalChromeWidth(paddingX);
		return Math.max(0, width - chromeWidth - this.#getPromptGutterWidth(width, paddingX));
	}

	#getLayoutWidth(width: number, paddingX: number): number {
		const contentWidth = this.#getContentWidth(width, paddingX);
		const cursorReserve = this.#borderVisible && paddingX === 0 ? 1 : 0;
		return Math.max(1, contentWidth - cursorReserve);
	}

	#getVisibleContentHeight(contentLines: number): number {
		if (this.#maxHeight === undefined) return contentLines;
		const verticalChrome = this.#borderVisible ? 2 : 0;
		return Math.max(1, this.#maxHeight - verticalChrome);
	}

	#decorate(text: string): string {
		const decorate = this.decorateText;
		if (decorate === undefined || text.length === 0) return text;
		const idx = text.indexOf(CURSOR_MARKER);
		if (idx === -1) return decorate(text);
		const before = text.slice(0, idx);
		const after = text.slice(idx + CURSOR_MARKER.length);
		return (before.length > 0 ? decorate(before) : "") + CURSOR_MARKER + (after.length > 0 ? decorate(after) : "");
	}

	#getStyledInputCursor(): { text: string; width: number } {
		const cursorChar = this.#theme.symbols.inputCursor;
		return { text: cursorChar, width: visibleWidth(cursorChar) };
	}

	#renderEndOfLineCursorAtWidthLimit(
		before: string,
		marker: string,
		maxWidth: number,
		replacement?: { text: string; width: number },
	): { text: string; width: number } {
		let lastGrapheme = "";
		for (const seg of segmenter.segment(before)) lastGrapheme = seg.segment;
		const lastGraphemeWidth = lastGrapheme ? visibleWidth(lastGrapheme) : 0;
		const builtInCursor = this.#getStyledInputCursor();
		const fallbackReplacement = lastGrapheme
			? { text: `\x1b[7m${lastGrapheme}\x1b[0m`, width: lastGraphemeWidth }
			: builtInCursor;
		const clampReplacement = (candidate: { text: string; width: number }): { text: string; width: number } => {
			let text = sliceByColumn(candidate.text, 0, maxWidth, true);
			let width = visibleWidth(text);
			if (width > maxWidth) {
				text = "";
				width = 0;
			}
			return { text, width };
		};

		let clampedReplacement = clampReplacement(replacement ?? fallbackReplacement);
		if (replacement && clampedReplacement.width === 0) {
			clampedReplacement = clampReplacement(fallbackReplacement);
		}
		if (lastGrapheme && clampedReplacement.width === 0) {
			clampedReplacement = clampReplacement(builtInCursor);
		}

		const replacedSpanWidth = Math.min(maxWidth, Math.max(lastGraphemeWidth, clampedReplacement.width));
		const prefixWidth = Math.max(0, maxWidth - replacedSpanWidth);
		const beforePrefix = sliceByColumn(before, 0, prefixWidth, true);
		const replacementPad = padding(Math.max(0, replacedSpanWidth - clampedReplacement.width));
		return {
			text: `${beforePrefix}${replacementPad}${clampedReplacement.text}${marker}`,
			width: visibleWidth(beforePrefix) + replacedSpanWidth,
		};
	}

	#renderTerminalCursorMarker(text: string, marker: string, maxWidth: number): string {
		if (!marker) return text;
		if (visibleWidth(text) < maxWidth) {
			return text + marker;
		}

		let insertAt = text.length;
		let offset = 0;
		for (const seg of segmenter.segment(text)) {
			if (visibleWidth(seg.segment) > 0) {
				insertAt = offset;
			}
			offset += seg.segment.length;
		}

		return `${text.slice(0, insertAt)}${marker}${text.slice(insertAt)}`;
	}

	#getPageScrollStep(totalVisualLines: number): number {
		const visibleHeight =
			this.#maxHeight === undefined ? DEFAULT_PAGE_SCROLL_LINES : this.#getVisibleContentHeight(totalVisualLines);
		return Math.max(1, visibleHeight - 1);
	}

	#updateScrollOffset(layoutWidth: number, layoutLines: LayoutLine[], visibleHeight: number): void {
		if (layoutLines.length <= visibleHeight) {
			this.#scrollOffset = 0;
			return;
		}

		const visualLines = this.#buildVisualLineMap(layoutWidth);
		const cursorLine = this.#findCurrentVisualLine(visualLines);
		if (cursorLine < this.#scrollOffset) {
			this.#scrollOffset = cursorLine;
		} else if (cursorLine >= this.#scrollOffset + visibleHeight) {
			this.#scrollOffset = cursorLine - visibleHeight + 1;
		}

		const maxOffset = Math.max(0, layoutLines.length - visibleHeight);
		this.#scrollOffset = Math.min(this.#scrollOffset, maxOffset);
	}

	render(width: number): readonly string[] {
		const paddingX = this.#getEditorPaddingX();
		const borderVisible = this.#borderVisible;
		const promptGutter = this.#getPromptGutter(width, paddingX);
		const contentAreaWidth = this.#getContentWidth(width, paddingX);
		const layoutWidth = this.#getLayoutWidth(width, paddingX);
		this.#lastLayoutWidth = layoutWidth;

		const box = this.#theme.symbols.boxSharp;
		const borderWidth = this.#getHorizontalChromeWidth(paddingX);
		const topLeft = this.borderColor(`${box.topLeft}${box.horizontal.repeat(paddingX)}`);
		const topRight = this.borderColor(`${box.horizontal.repeat(paddingX)}${box.topRight}`);
		const bottomLeft = this.borderColor(`${box.bottomLeft}${box.horizontal}${padding(Math.max(0, paddingX - 1))}`);
		const horizontal = this.borderColor(box.horizontal);

		const layoutLines = this.#layoutText(layoutWidth);
		const visibleContentHeight = this.#getVisibleContentHeight(layoutLines.length);
		this.#updateScrollOffset(layoutWidth, layoutLines, visibleContentHeight);
		const visibleLayoutLines = layoutLines.slice(this.#scrollOffset, this.#scrollOffset + visibleContentHeight);

		const result: string[] = [];

		if (borderVisible) {
			const topFillWidth = Math.max(0, width - borderWidth * 2);
			result.push(topLeft + horizontal.repeat(topFillWidth) + topRight);
		}

		this.#textRowStart = borderVisible ? 1 : 0;
		this.#textRowCount = visibleLayoutLines.length;
		this.#textColStart = borderVisible ? 1 + paddingX : (promptGutter?.width ?? 0);
		this.#textScrollOffset = this.#scrollOffset;

		const emitCursorMarker = this.focused && !this.#autocompleteState;
		const lineContentWidth = contentAreaWidth;

		const inlineHint = this.#getInlineHint();
		const hintStyle = this.#theme.hintStyle ?? ((t: string) => `\x1b[2m${t}\x1b[0m`);

		for (let visibleIndex = 0; visibleIndex < visibleLayoutLines.length; visibleIndex++) {
			const layoutLine = visibleLayoutLines[visibleIndex]!;
			let displayText = layoutLine.text;
			let displayWidth = visibleWidth(layoutLine.text);
			let cursorPaddingOverflow = 0;
			let decorated = false;
			const showPromptGutter = promptGutter !== undefined && visibleIndex === 0;
			const gutterText =
				promptGutter === undefined ? "" : showPromptGutter ? promptGutter.firstLine : promptGutter.continuation;

			const hasCursor = layoutLine.hasCursor && layoutLine.cursorPos !== undefined;
			const marker = emitCursorMarker ? CURSOR_MARKER : "";

			if (!borderVisible && displayWidth > lineContentWidth) {
				displayText = sliceByColumn(displayText, 0, lineContentWidth, true);
				displayWidth = visibleWidth(displayText);
			}

			if (!borderVisible && lineContentWidth === 0) {
				if (hasCursor && !this.#useTerminalCursor) {
					const zeroWidthCursorBudget = visibleWidth(gutterText);
					const zeroWidthCursorReplacement = this.cursorOverride
						? { text: this.cursorOverride, width: this.cursorOverrideWidth ?? 1 }
						: this.#getStyledInputCursor();
					if (showPromptGutter && zeroWidthCursorBudget > 0) {
						let promptGlyph = "";
						for (const seg of segmenter.segment(gutterText)) {
							promptGlyph = seg.segment;
							break;
						}
						const promptGlyphWidth = visibleWidth(promptGlyph);
						const remainingCursorWidth = Math.max(0, zeroWidthCursorBudget - promptGlyphWidth);
						if (remainingCursorWidth === 0) {
							result.push(`\x1b[7m${promptGlyph}\x1b[0m${marker}`);
						} else {
							const widthLimitedCursor = this.#renderEndOfLineCursorAtWidthLimit(
								"",
								marker,
								remainingCursorWidth,
								zeroWidthCursorReplacement,
							);
							result.push(`${promptGlyph}${widthLimitedCursor.text}`);
						}
					} else {
						const widthLimitedCursor = this.#renderEndOfLineCursorAtWidthLimit(
							gutterText,
							marker,
							zeroWidthCursorBudget,
							zeroWidthCursorReplacement,
						);
						result.push(widthLimitedCursor.text);
					}
				} else if (hasCursor && this.#useTerminalCursor) {
					result.push(this.#renderTerminalCursorMarker(gutterText, marker, visibleWidth(gutterText)));
				} else {
					result.push(gutterText + (hasCursor ? marker : ""));
				}
				continue;
			}

			if (hasCursor && this.#useTerminalCursor) {
				if (marker) {
					const before = displayText.slice(0, layoutLine.cursorPos);
					const after = displayText.slice(layoutLine.cursorPos);
					if (after.length === 0 && inlineHint) {
						const availWidth = Math.max(0, lineContentWidth - displayWidth - 1);
						const truncatedHint = truncateToWidth(inlineHint, availWidth);
						const hintText = truncatedHint.length > 0 ? ` ${hintStyle(truncatedHint)}` : "";
						displayText = before + marker + hintText;
						displayWidth += truncatedHint.length > 0 ? 1 + Math.min(visibleWidth(inlineHint), availWidth) : 0;
					} else if (after.length === 0 && !borderVisible && displayWidth >= lineContentWidth) {
						displayText = this.#renderTerminalCursorMarker(before, marker, lineContentWidth);
					} else {
						displayText = before + marker + after;
					}
				}
			} else if (hasCursor && !this.#useTerminalCursor) {
				const before = displayText.slice(0, layoutLine.cursorPos);
				const after = displayText.slice(layoutLine.cursorPos);

				if (after.length > 0) {
					let firstGrapheme = "";
					for (const seg of segmenter.segment(after)) {
						firstGrapheme = seg.segment;
						break;
					}
					const restAfter = after.slice(firstGrapheme.length);
					const cursor = `\x1b[7m${firstGrapheme}\x1b[0m`;
					displayText = this.#decorate(before) + marker + cursor + this.#decorate(restAfter);
					decorated = true;
				} else if (this.cursorOverride) {
					const overrideWidth = this.cursorOverrideWidth ?? 1;
					if (!borderVisible && displayWidth + overrideWidth > lineContentWidth) {
						const widthLimitedCursor = this.#renderEndOfLineCursorAtWidthLimit(before, marker, lineContentWidth, {
							text: this.cursorOverride,
							width: overrideWidth,
						});
						displayText = widthLimitedCursor.text;
						displayWidth = widthLimitedCursor.width;
					} else if (inlineHint) {
						const availWidth = Math.max(0, lineContentWidth - displayWidth - overrideWidth - 1);
						const truncatedHint = truncateToWidth(inlineHint, availWidth);
						const hintText = truncatedHint.length > 0 ? ` ${hintStyle(truncatedHint)}` : "";
						displayText = before + marker + this.cursorOverride + hintText;
						displayWidth +=
							overrideWidth +
							(truncatedHint.length > 0 ? 1 + Math.min(visibleWidth(inlineHint), availWidth) : 0);
					} else {
						displayText = before + marker + this.cursorOverride;
						displayWidth += overrideWidth;
					}
				} else {
					const { text: cursor, width: cursorWidth } = this.#getStyledInputCursor();
					if (!borderVisible && displayWidth + cursorWidth > lineContentWidth) {
						const widthLimitedCursor = this.#renderEndOfLineCursorAtWidthLimit(before, marker, lineContentWidth);
						displayText = widthLimitedCursor.text;
						displayWidth = widthLimitedCursor.width;
					} else if (inlineHint) {
						const availWidth = Math.max(0, lineContentWidth - displayWidth - cursorWidth - 1);
						const truncatedHint = truncateToWidth(inlineHint, availWidth);
						const hintText = truncatedHint.length > 0 ? ` ${hintStyle(truncatedHint)}` : "";
						displayText = before + marker + cursor + hintText;
						displayWidth +=
							cursorWidth + (truncatedHint.length > 0 ? 1 + Math.min(visibleWidth(inlineHint), availWidth) : 0);
					} else {
						displayText = before + marker + cursor;
						displayWidth += cursorWidth;
					}
					if (displayWidth > lineContentWidth && paddingX > 0) {
						cursorPaddingOverflow = displayWidth - lineContentWidth;
					}
				}
			}

			if (!decorated) {
				displayText = this.#decorate(displayText);
			}
			if (!hasCursor) {
				displayWidth = visibleWidth(displayText);
				if (displayWidth > lineContentWidth) {
					displayText = truncateToWidth(displayText, lineContentWidth);
					displayWidth = visibleWidth(displayText);
				}
			}

			const linePad = padding(Math.max(0, lineContentWidth - displayWidth));

			if (!borderVisible) {
				result.push(gutterText + displayText + linePad);
				continue;
			}

			const isLastLine = visibleIndex === visibleLayoutLines.length - 1;
			const rightChromeCells = Math.max(1, paddingX + 1 - cursorPaddingOverflow);
			if (isLastLine) {
				const rightPad = Math.max(0, rightChromeCells - 2);
				const includeHorizontal = rightChromeCells >= 2;
				const bottomRightAdjusted = this.borderColor(
					`${padding(rightPad)}${includeHorizontal ? box.horizontal : ""}${box.bottomRight}`,
				);
				result.push(`${bottomLeft}${displayText}${linePad}${bottomRightAdjusted}`);
			} else {
				const leftBorder = this.borderColor(`${box.vertical}${padding(paddingX)}`);
				const rightBorder = this.borderColor(`${padding(Math.max(0, rightChromeCells - 1))}${box.vertical}`);
				result.push(leftBorder + displayText + linePad + rightBorder);
			}
		}

		if (!borderVisible && this.#rowBackground) {
			const ground = this.#rowBackground;
			for (let i = 0; i < result.length; i++) {
				result[i] = `${ground}${reopenBackgroundAfterResets(result[i]!, ground)}${SGR_BG_RESET}`;
			}
		}

		if (this.#autocompleteState && this.#autocompleteList) {
			this.#autocompleteRowStart = result.length;
			const autocompleteResult = this.#autocompleteList.render(width);
			const autocompleteRows = this.#autocompleteReveal?.apply(autocompleteResult) ?? autocompleteResult;
			for (let ai = 0; ai < autocompleteRows.length; ai++) result.push(autocompleteRows[ai]!);
		} else {
			this.#autocompleteRowStart = -1;
		}

		return result;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (this.#jumpMode !== null) {
			if (kb.matches(data, "tui.editor.jumpForward") || kb.matches(data, "tui.editor.jumpBackward")) {
				this.#jumpMode = null;
				return;
			}

			const printableText = extractPrintableText(data);
			if (printableText) {
				const direction = this.#jumpMode;
				this.#jumpMode = null;
				this.#jumpToChar(printableText, direction);
				return;
			}

			this.#jumpMode = null;
		}

		const paste = this.#pasteHandler.process(data);
		if (paste.handled) {
			if (paste.prefix !== undefined && paste.prefix.length > 0) {
				this.#handleKeyInput(paste.prefix);
			}
			if (paste.pasteContent !== undefined) {
				this.#handlePaste(paste.pasteContent);
				if (paste.remaining.length > 0) {
					this.handleInput(paste.remaining);
				}
			}
			return;
		}

		this.#handleKeyInput(data);
	}

	#handleKeyInput(data: string): void {
		const kb = getKeybindings();

		if (matchesKey(data, "ctrl+c")) {
			return;
		}

		if (kb.matches(data, "tui.editor.undo")) {
			this.#applyUndo();
			return;
		}

		if (this.#autocompleteState && this.#autocompleteList) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.#cancelAutocomplete(true);
				return;
			} else if (
				kb.matches(data, "tui.select.up") ||
				kb.matches(data, "tui.select.down") ||
				kb.matches(data, "tui.select.pageUp") ||
				kb.matches(data, "tui.select.pageDown") ||
				kb.matches(data, "tui.input.submit") ||
				isLoneLineFeed(data) ||
				kb.matches(data, "tui.input.tab")
			) {
				if (
					kb.matches(data, "tui.select.up") ||
					kb.matches(data, "tui.select.down") ||
					kb.matches(data, "tui.select.pageUp") ||
					kb.matches(data, "tui.select.pageDown")
				) {
					this.#autocompleteList.handleInput(data);
					this.onAutocompleteUpdate?.();
					return;
				}

				if (kb.matches(data, "tui.input.tab")) {
					this.#acceptAutocompleteSelection(this.#autocompleteList.getSelectedItem());
					return;
				}

				if (
					(kb.matches(data, "tui.input.submit") || isLoneLineFeed(data)) &&
					findLeadingSlashCommandStart(this.#autocompletePrefix) !== null &&
					!this.#selectedCompletionIsPath()
				) {
					const selected = this.#autocompleteList.getSelectedItem();
					const currentLine = this.#state.lines[this.#state.cursorLine] ?? "";
					const currentTextBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
					if (!this.#autocompletePrefixMatchesCursorText(currentTextBeforeCursor, selected)) {
						this.#cancelAutocomplete();
					} else {
						if (selected && this.#autocompleteProvider) {
							const result = this.#autocompleteProvider.applyCompletion(
								this.#state.lines,
								this.#state.cursorLine,
								this.#state.cursorCol,
								selected,
								this.#autocompletePrefix,
							);

							this.#state.lines = result.lines;
							this.#state.cursorLine = result.cursorLine;
							this.#setCursorCol(result.cursorCol);
							result.onApplied?.();
						}
						this.#cancelAutocomplete();
					}
				} else if (kb.matches(data, "tui.input.submit") || isLoneLineFeed(data)) {
					const selected = this.#autocompleteList.getSelectedItem();
					const currentLine = this.#state.lines[this.#state.cursorLine] ?? "";
					const currentTextBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
					if (!this.#autocompletePrefixMatchesCursorText(currentTextBeforeCursor, selected)) {
						this.#cancelAutocomplete();
					} else {
						if (selected && this.#autocompleteProvider) {
							const result = this.#autocompleteProvider.applyCompletion(
								this.#state.lines,
								this.#state.cursorLine,
								this.#state.cursorCol,
								selected,
								this.#autocompletePrefix,
							);

							this.#state.lines = result.lines;
							this.#state.cursorLine = result.cursorLine;
							this.#setCursorCol(result.cursorCol);

							this.#cancelAutocomplete();
							this.onAutocompleteUpdate?.();

							if (this.onChange) {
								this.onChange(this.getText());
							}

							result.onApplied?.();
						}
						return;
					}
				}
			}
		}

		if (kb.matches(data, "tui.input.tab") && !this.#autocompleteState) {
			this.#handleTabCompletion();
			return;
		}

		if (matchesKey(data, "ctrl+k")) {
			this.#deleteToEndOfLine();
		} else if (matchesKey(data, "ctrl+u")) {
			this.#deleteToStartOfLine();
		} else if (matchesKey(data, "ctrl+w")) {
			this.#deleteWordBackwards();
		} else if (matchesKey(data, "alt+backspace") || matchesKey(data, "super+alt+backspace")) {
			this.#deleteWordBackwards();
		} else if (
			matchesKey(data, "alt+d") ||
			matchesKey(data, "alt+delete") ||
			matchesKey(data, "super+alt+d") ||
			matchesKey(data, "super+alt+delete")
		) {
			this.#deleteWordForwards();
		} else if (matchesKey(data, "ctrl+y")) {
			this.#yankFromKillRing();
		} else if (matchesKey(data, "alt+y")) {
			this.#yankPop();
		} else if (matchesKey(data, "ctrl+a")) {
			this.#moveToLineStart();
		} else if (matchesKey(data, "ctrl+e")) {
			this.#moveToLineEnd();
		} else if (matchesKey(data, "alt+enter")) {
			if (this.onAltEnter) {
				this.onAltEnter(this.getText());
			} else {
				this.#addNewLine();
			}
		} else if (
			(data.charCodeAt(0) === 10 && data.length > 1) || // Ctrl+Enter with modifiers
			matchesKey(data, "ctrl+enter") || // Ctrl+Enter (Kitty/modifyOtherKeys, including lock bits/keypad Enter)
			data === "\x1b\r" || // Option+Enter in some terminals (legacy)
			data === "\x1b[13;2~" || // Shift+Enter in some terminals (legacy format)
			kb.matches(data, "tui.input.newLine") || // Shift+Enter (Kitty protocol, handles lock bits)
			(data.length > 1 && data.includes("\x1b") && data.includes("\r")) ||
			isLoneLineFeed(data) // Shift+Enter from iTerm2 mapping
		) {
			if (this.#shouldSubmitOnBackslashEnter(data, kb)) {
				this.#handleBackspace();
				this.#submitValue();
				return;
			}
			this.#addNewLine();
		} else if (kb.matches(data, "tui.input.submit") || isLoneLineFeed(data)) {
			if (this.disableSubmit) {
				return;
			}

			if (!this.#autocompleteState) {
				const currentLine = this.#state.lines[this.#state.cursorLine] ?? "";
				const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
				if (
					findLeadingSlashCommandStart(textBeforeCursor) !== null &&
					this.#isInSubmittedSlashCommandContext() &&
					this.#autocompleteProvider?.trySyncSlashCompletion
				) {
					const syncResult = this.#autocompleteProvider.trySyncSlashCompletion(textBeforeCursor);
					if (syncResult && syncResult.items.length > 0) {
						this.#autocompleteRequestId += 1;
						const selected = syncResult.items[0]!;
						const result = this.#autocompleteProvider.applyCompletion(
							this.#state.lines,
							this.#state.cursorLine,
							this.#state.cursorCol,
							selected,
							syncResult.prefix,
						);
						this.#state.lines = result.lines;
						this.#state.cursorLine = result.cursorLine;
						this.#setCursorCol(result.cursorCol);
						result.onApplied?.();
					}
				}
			}

			this.#submitValue();
		} else if (kb.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, "shift+backspace")) {
			this.#handleBackspace();
		} else if (kb.matches(data, "tui.editor.cursorLineStart")) {
			this.#moveToLineStart();
		} else if (kb.matches(data, "tui.editor.cursorLineEnd")) {
			this.#moveToLineEnd();
		} else if (kb.matches(data, "tui.editor.pageUp")) {
			this.#pageScroll(-1);
		} else if (kb.matches(data, "tui.editor.pageDown")) {
			this.#pageScroll(1);
		} else if (kb.matches(data, "tui.editor.deleteCharForward") || matchesKey(data, "shift+delete")) {
			this.#handleForwardDelete();
		} else if (kb.matches(data, "tui.editor.cursorWordLeft")) {
			this.#resetKillSequence();
			this.#moveWordBackwards();
		} else if (kb.matches(data, "tui.editor.cursorWordRight")) {
			this.#resetKillSequence();
			this.#moveWordForwards();
		} else if (kb.matches(data, "tui.editor.cursorUp")) {
			if (this.#isEditorEmpty()) {
				this.#navigateHistory(-1); // Start browsing history
			} else if (this.#historyIndex > -1 && this.#isOnFirstVisualLine()) {
				this.#navigateHistory(-1); // Navigate to older history entry
			} else if (this.#isOnFirstVisualLine()) {
				this.#moveToLineStart();
			} else {
				this.#moveCursor(-1, 0); // Cursor movement (within text or history entry)
			}
		} else if (kb.matches(data, "tui.editor.cursorDown")) {
			if (this.#historyIndex > -1 && this.#isOnLastVisualLine()) {
				this.#navigateHistory(1); // Navigate to newer history entry or clear
			} else if (this.#isOnLastVisualLine()) {
				this.#moveToLineEnd();
			} else {
				this.#moveCursor(1, 0); // Cursor movement (within text or history entry)
			}
		} else if (kb.matches(data, "tui.editor.cursorRight")) {
			this.#moveCursor(0, 1);
		} else if (kb.matches(data, "tui.editor.cursorLeft")) {
			this.#moveCursor(0, -1);
		} else if (matchesKey(data, "shift+space")) {
			this.#insertCharacter(" ");
		} else if (kb.matches(data, "tui.editor.jumpForward")) {
			this.#jumpMode = "forward";
		} else if (kb.matches(data, "tui.editor.jumpBackward")) {
			this.#jumpMode = "backward";
		} else {
			const printableText = extractPrintableText(data);
			if (printableText) {
				this.#insertCharacter(printableText);
			}
		}
	}

	#wrapLine(line: string, width: number): TextChunk[] {
		if (width !== this.#wrapCacheWidth) {
			this.#wrapCache.clear();
			this.#wrapCacheWidth = width;
		}
		let chunks = this.#wrapCache.get(line);
		if (chunks === undefined) {
			if (this.#wrapCache.size >= 256) {
				this.#wrapCache.clear();
			}
			chunks = wordWrapLine(line, width);
			this.#wrapCache.set(line, chunks);
		}
		return chunks;
	}

	#layoutText(contentWidth: number): LayoutLine[] {
		const layoutLines: LayoutLine[] = [];

		if (this.#state.lines.length === 0 || (this.#state.lines.length === 1 && this.#state.lines[0] === "")) {
			layoutLines.push({
				text: "",
				hasCursor: true,
				cursorPos: 0,
			});
			return layoutLines;
		}

		for (let i = 0; i < this.#state.lines.length; i++) {
			const line = this.#state.lines[i] || "";
			const isCurrentLine = i === this.#state.cursorLine;
			const lineVisibleWidth = visibleWidth(line);

			if (lineVisibleWidth <= contentWidth) {
				if (isCurrentLine) {
					layoutLines.push({
						text: line,
						hasCursor: true,
						cursorPos: this.#state.cursorCol,
					});
				} else {
					layoutLines.push({
						text: line,
						hasCursor: false,
					});
				}
			} else {
				const chunks = this.#wrapLine(line, contentWidth);

				for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
					const chunk = chunks[chunkIndex];
					if (!chunk) continue;

					const cursorPos = this.#state.cursorCol;
					const isLastChunk = chunkIndex === chunks.length - 1;

					let hasCursorInChunk = false;
					let adjustedCursorPos = 0;

					if (isCurrentLine) {
						const chunkStart = chunkIndex === 0 ? 0 : chunk.startIndex;
						if (isLastChunk) {
							hasCursorInChunk = cursorPos >= chunkStart;
						} else {
							hasCursorInChunk = cursorPos >= chunkStart && cursorPos < chunk.endIndex;
						}
						if (hasCursorInChunk) {
							adjustedCursorPos = clampLow(cursorPos - chunk.startIndex, 0, chunk.text.length);
						}
					}

					if (hasCursorInChunk) {
						layoutLines.push({
							text: chunk.text,
							hasCursor: true,
							cursorPos: adjustedCursorPos,
						});
					} else {
						layoutLines.push({
							text: chunk.text,
							hasCursor: false,
						});
					}
				}
			}
		}

		return layoutLines;
	}

	getText(): string {
		return this.#state.lines.join("\n");
	}

	#expandPasteMarkers(text: string): string {
		let result = text;
		for (const [pasteId, pasteContent] of this.#pastes) {
			const markerRegex = new RegExp(`\\[Paste #${pasteId}(?:, (?:\\+\\d+ lines|\\d+ chars))?\\]`, "g");
			result = result.replace(markerRegex, () => pasteContent);
		}
		return result;
	}

	getExpandedText(): string {
		return this.#expandPasteMarkers(this.#state.lines.join("\n"));
	}

	getLines(): string[] {
		return this.#state.lines.slice();
	}

	getCursor(): { line: number; col: number } {
		return { line: this.#state.cursorLine, col: this.#state.cursorCol };
	}

	moveToLineStart(): void {
		this.#moveToLineStart();
	}

	moveToLineEnd(): void {
		this.#moveToLineEnd();
	}

	moveToMessageStart(): void {
		this.#moveToMessageStart();
	}

	moveToMessageEnd(): void {
		this.#moveToMessageEnd();
	}

	undoPastTransientText(transientText: string): void {
		if (transientText.length === 0) {
			this.#applyUndo();
			return;
		}

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const transientStartCol = this.#state.cursorCol - transientText.length;
		if (transientStartCol < 0 || currentLine.slice(transientStartCol, this.#state.cursorCol) !== transientText) {
			this.#applyUndo();
			return;
		}

		const beforeTransient = currentLine.slice(0, transientStartCol);
		const afterTransient = currentLine.slice(this.#state.cursorCol);
		this.#historyIndex = -1;
		this.#resetKillSequence();
		this.#preferredVisualCol = null;
		this.#state.lines[this.#state.cursorLine] = beforeTransient + afterTransient;
		this.#setCursorCol(transientStartCol);

		while (true) {
			const snapshot = this.#undoStack.at(-1);
			if (
				!snapshot ||
				!this.#matchesTransientUndoSnapshot(
					snapshot,
					transientText,
					transientStartCol,
					beforeTransient,
					afterTransient,
				)
			) {
				break;
			}
			this.#undoStack.pop();
		}

		if (this.#undoStack.length === 0) {
			if (this.onChange) {
				this.onChange(this.getText());
			}
			return;
		}

		this.#applyUndo();
	}

	setText(text: string): void {
		this.#historyIndex = -1; // Exit history browsing mode
		this.#resetKillSequence();
		this.#setTextInternal(text);
	}
	submit(): void {
		if (this.disableSubmit) return;
		this.#submitValue();
	}

	#exitHistoryForEditing(): void {
		if (this.#historyIndex === -1) return;
		if (this.#state.cursorLine === 0 && this.#state.cursorCol === 0) {
			this.#state.cursorLine = this.#state.lines.length - 1;
			const line = this.#state.lines[this.#state.cursorLine] || "";
			this.#setCursorCol(line.length);
		}
		this.#historyIndex = -1;
	}

	insertText(text: string): void {
		this.#exitHistoryForEditing();
		this.#insertTextAtCursor(text);
	}

	deleteBeforeCursor(count: number): void {
		const removable = Math.min(count, this.#state.cursorCol);
		if (removable <= 0) return;
		this.#exitHistoryForEditing();
		this.#recordUndoState();
		const line = this.#state.lines[this.#state.cursorLine] ?? "";
		this.#state.lines[this.#state.cursorLine] =
			line.slice(0, this.#state.cursorCol - removable) + line.slice(this.#state.cursorCol);
		this.#setCursorCol(this.#state.cursorCol - removable);
		this.#lastAction = null;
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	#volatileTextLen = 0;

	setVolatileText(text: string): void {
		this.#exitHistoryForEditing();
		this.#withUndoSuspended(() => {
			this.#deleteCharsBeforeCursor(this.#volatileTextLen);
			if (text) this.#insertTextAtCursor(text);
		});
		this.#volatileTextLen = text.length;
		if (!text && this.onChange) this.onChange(this.getText());
	}

	clearVolatileText(): void {
		if (this.#volatileTextLen === 0) return;
		this.#withUndoSuspended(() => this.#deleteCharsBeforeCursor(this.#volatileTextLen));
		this.#volatileTextLen = 0;
		if (this.onChange) this.onChange(this.getText());
	}

	commitVolatileText(text: string): void {
		this.#exitHistoryForEditing();
		this.#withUndoSuspended(() => this.#deleteCharsBeforeCursor(this.#volatileTextLen));
		this.#volatileTextLen = 0;
		if (text) this.#insertTextAtCursor(text);
		else if (this.onChange) this.onChange(this.getText());
	}

	#deleteCharsBeforeCursor(count: number): void {
		let remaining = count;
		while (remaining > 0) {
			if (this.#state.cursorCol > 0) {
				const removable = Math.min(remaining, this.#state.cursorCol);
				const line = this.#state.lines[this.#state.cursorLine] ?? "";
				this.#state.lines[this.#state.cursorLine] =
					line.slice(0, this.#state.cursorCol - removable) + line.slice(this.#state.cursorCol);
				this.#setCursorCol(this.#state.cursorCol - removable);
				remaining -= removable;
			} else if (this.#state.cursorLine > 0) {
				const prev = this.#state.lines[this.#state.cursorLine - 1] ?? "";
				const cur = this.#state.lines[this.#state.cursorLine] ?? "";
				this.#state.lines[this.#state.cursorLine - 1] = prev + cur;
				this.#state.lines.splice(this.#state.cursorLine, 1);
				this.#state.cursorLine -= 1;
				this.#setCursorCol(prev.length);
				remaining -= 1;
			} else {
				break;
			}
		}
	}

	pasteText(text: string): void {
		this.#handlePaste(text);
	}

	insertPaste(content: string): void {
		this.#historyIndex = -1;
		this.#resetKillSequence();
		this.#recordUndoState();
		this.#withUndoSuspended(() => {
			this.#storePasteMarker(content, content.split("\n").length);
		});
	}

	#insertCharacter(char: string): void {
		this.#exitHistoryForEditing();
		let isWordChunk = true;
		for (const seg of segmenter.segment(char)) {
			if (getWordNavKind(seg.segment) === "whitespace") {
				isWordChunk = false;
				break;
			}
		}
		if (!isWordChunk || this.#lastAction !== "type-word") {
			this.#recordUndoState();
		}
		this.#lastAction = isWordChunk ? "type-word" : null;

		const line = this.#state.lines[this.#state.cursorLine] || "";

		const before = line.slice(0, this.#state.cursorCol);
		const after = line.slice(this.#state.cursorCol);

		this.#state.lines[this.#state.cursorLine] = before + char + after;
		this.#setCursorCol(this.#state.cursorCol + char.length);

		if (this.onChange) {
			this.onChange(this.getText());
		}

		if (char.length === 1 && this.#autocompleteProvider?.trySyncInlineReplace) {
			const replaceLine = this.#state.lines[this.#state.cursorLine] || "";
			const textBeforeCursor = replaceLine.slice(0, this.#state.cursorCol);
			const replacement = this.#autocompleteProvider.trySyncInlineReplace(textBeforeCursor);
			if (replacement) {
				const before = replaceLine.slice(0, this.#state.cursorCol - replacement.replaceLen);
				const after = replaceLine.slice(this.#state.cursorCol);
				this.#state.lines[this.#state.cursorLine] = before + replacement.insert + after;
				this.#setCursorCol(before.length + replacement.insert.length);
				if (this.onChange) {
					this.onChange(this.getText());
				}
				if (this.#autocompleteState) {
					this.#cancelAutocomplete();
					this.onAutocompleteUpdate?.();
				}
				return;
			}
		}

		if (!this.#autocompleteState) {
			if (char === "/" && (this.#isAtStartOfSubmittedMessage() || this.#isInMidPromptSkillSlashContext())) {
				this.#tryTriggerAutocomplete();
			} else if (char === "@") {
				const currentLine = this.#state.lines[this.#state.cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
				const charBeforeAt = textBeforeCursor[textBeforeCursor.length - 2];
				if (textBeforeCursor.length === 1 || charBeforeAt === " " || charBeforeAt === "\t") {
					this.#tryTriggerAutocomplete();
				}
			} else if (char === "#") {
				this.#tryTriggerAutocomplete();
			} else if (/[a-zA-Z0-9.\-_/]/.test(char)) {
				const currentLine = this.#state.lines[this.#state.cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
				if (this.#isInSlashAutocompleteContext()) {
					this.#tryTriggerAutocomplete();
				} else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
					this.#tryTriggerAutocomplete();
				} else if (textBeforeCursor.match(/#[^\s#]*$/)) {
					this.#tryTriggerAutocomplete();
				} else if (textBeforeCursor.match(/(?:^|[\s([{>]):[a-zA-Z0-9_+-]*$/)) {
					this.#tryTriggerAutocomplete();
				} else if (this.#textTriggersUrlAutocomplete(textBeforeCursor)) {
					this.#tryTriggerAutocomplete();
				}
			}
		} else {
			this.#debouncedUpdateAutocomplete();
		}
	}

	#handlePaste(pastedText: string): void {
		let filteredText = this.#sanitizePastedText(pastedText);

		if (/^[/~.]/.test(filteredText)) {
			const currentLine = this.#state.lines[this.#state.cursorLine] || "";
			const charBeforeCursor = this.#state.cursorCol > 0 ? currentLine[this.#state.cursorCol - 1] : "";
			if (charBeforeCursor && /\w/.test(charBeforeCursor)) {
				filteredText = ` ${filteredText}`;
			}
		}

		const pastedLines = filteredText.split("\n");
		const totalChars = filteredText.length;
		const isMarkerSized = pastedLines.length > 10 || totalChars > 1000;

		if (isMarkerSized && this.onLargePaste?.(filteredText, pastedLines.length)) {
			return;
		}

		this.#historyIndex = -1; // Exit history browsing mode
		this.#resetKillSequence();
		this.#recordUndoState();

		this.#withUndoSuspended(() => {
			if (isMarkerSized) {
				this.#storePasteMarker(filteredText, pastedLines.length);
				return;
			}

			if (pastedLines.length === 1) {
				if (filteredText) {
					this.#insertTextAtCursor(filteredText);
				}
				return;
			}

			this.#insertTextAtCursor(filteredText);
		});
	}

	#sanitizePastedText(pastedText: string): string {
		const decodedText = decodeReencodedPasteControls(pastedText);

		const cleanText = decodedText.replace(/\r\n?/g, "\n").normalize("NFC");

		const tabExpandedText = cleanText.replace(/\t/g, "   ");

		return tabExpandedText.replace(/[\x00-\x09\x0B-\x1F]/g, "");
	}

	#storePasteMarker(content: string, lineCount: number): void {
		this.#pasteCounter++;
		const pasteId = this.#pasteCounter;
		this.#pastes.set(pasteId, content);

		const marker =
			lineCount > 10 ? `[Paste #${pasteId}, +${lineCount} lines]` : `[Paste #${pasteId}, ${content.length} chars]`;
		this.#insertTextAtCursor(marker);
	}

	#retriggerAutocompleteAtCursor(): void {
		if (this.#autocompleteState) {
			this.#debouncedUpdateAutocomplete();
			return;
		}
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
		if (this.#isInSlashAutocompleteContext()) {
			this.#tryTriggerAutocomplete();
		} else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
			this.#tryTriggerAutocomplete();
		} else if (textBeforeCursor.match(/#[^\s#]*$/)) {
			this.#tryTriggerAutocomplete();
		} else if (this.#textTriggersUrlAutocomplete(textBeforeCursor)) {
			this.#tryTriggerAutocomplete();
		}
	}

	#addNewLine(): void {
		this.#historyIndex = -1; // Exit history browsing mode
		this.#resetKillSequence();
		this.#recordUndoState();

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";

		const before = currentLine.slice(0, this.#state.cursorCol);
		const after = currentLine.slice(this.#state.cursorCol);

		this.#state.lines[this.#state.cursorLine] = before;
		this.#state.lines.splice(this.#state.cursorLine + 1, 0, after);

		this.#state.cursorLine++;
		this.#setCursorCol(0);

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	#shouldSubmitOnBackslashEnter(data: string, kb: KeybindingsManager): boolean {
		if (this.disableSubmit) return false;
		if (!matchesKey(data, "enter")) return false;
		const submitKeys = kb.getKeys("tui.input.submit");
		const hasShiftEnter = submitKeys.includes("shift+enter") || submitKeys.includes("shift+return");
		if (!hasShiftEnter) return false;

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		return this.#state.cursorCol > 0 && currentLine[this.#state.cursorCol - 1] === "\\";
	}

	#submitValue(): void {
		this.#resetKillSequence();

		const result = this.#expandPasteMarkers(this.#state.lines.join("\n")).trim();

		this.#state = { lines: [""], cursorLine: 0, cursorCol: 0 };
		this.#pastes.clear();
		this.#pasteCounter = 0;
		this.#historyIndex = -1;
		this.#scrollOffset = 0;
		this.#undoStack.length = 0;

		if (this.onChange) this.onChange("");
		if (this.onSubmit) this.onSubmit(result);
	}

	#getAtomicTokenRe(): RegExp | undefined {
		const pattern = this.atomicTokenPattern;
		if (pattern === undefined) {
			this.#atomicTokenSource = undefined;
			this.#atomicTokenRe = undefined;
			return undefined;
		}
		if (pattern.source !== this.#atomicTokenSource) {
			this.#atomicTokenSource = pattern.source;
			this.#atomicTokenRe = new RegExp(
				pattern.source,
				pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
			);
		}
		return this.#atomicTokenRe;
	}

	#atomicTokenAt(line: string, col: number): { start: number; end: number } | undefined {
		const re = this.#getAtomicTokenRe();
		if (re === undefined) return undefined;
		re.lastIndex = 0;
		for (;;) {
			const match = re.exec(line);
			if (match === null) break;
			if (match[0].length === 0) {
				re.lastIndex = match.index + 1;
				continue;
			}
			const start = match.index;
			const end = start + match[0].length;
			if (col < start) break;
			if (col < end) return { start, end };
		}
		return undefined;
	}

	#expandRangeOverAtomicTokens(line: string, start: number, end: number): { start: number; end: number } {
		const startToken = this.#atomicTokenAt(line, start);
		if (startToken !== undefined && startToken.start < start) {
			start = startToken.start;
		}
		if (end > start) {
			const endToken = this.#atomicTokenAt(line, end - 1);
			if (endToken !== undefined && endToken.end > end) {
				end = endToken.end;
			}
		}
		return { start, end };
	}

	#handleBackspace(): void {
		this.#historyIndex = -1; // Exit history browsing mode
		this.#resetKillSequence();
		this.#recordUndoState();

		let removedSlashTrigger = false;

		if (this.#state.cursorCol > 0) {
			const line = this.#state.lines[this.#state.cursorLine] || "";
			const textBeforeCursor = line.slice(0, this.#state.cursorCol);
			const trailingSlashStart = findTrailingSlashCommandStart(textBeforeCursor);
			removedSlashTrigger = trailingSlashStart === this.#state.cursorCol - 1;
			const token = this.#atomicTokenAt(line, this.#state.cursorCol - 1);
			if (token !== undefined) {
				this.#state.lines[this.#state.cursorLine] = line.slice(0, token.start) + line.slice(token.end);
				this.#setCursorCol(token.start);
			} else {
				const beforeCursor = line.slice(0, this.#state.cursorCol);

				let lastGrapheme = "";
				for (const seg of segmenter.segment(beforeCursor)) lastGrapheme = seg.segment;
				const graphemeLength = lastGrapheme.length || 1;

				const before = line.slice(0, this.#state.cursorCol - graphemeLength);
				const after = line.slice(this.#state.cursorCol);

				this.#state.lines[this.#state.cursorLine] = before + after;
				this.#setCursorCol(this.#state.cursorCol - graphemeLength);
			}
		} else if (this.#state.cursorLine > 0) {
			const currentLine = this.#state.lines[this.#state.cursorLine] || "";
			const previousLine = this.#state.lines[this.#state.cursorLine - 1] || "";

			this.#state.lines[this.#state.cursorLine - 1] = previousLine + currentLine;
			this.#state.lines.splice(this.#state.cursorLine, 1);

			this.#state.cursorLine--;
			this.#setCursorCol(previousLine.length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}

		if (this.#autocompleteState) {
			if (removedSlashTrigger) {
				this.#cancelAutocomplete();
				this.onAutocompleteUpdate?.();
			} else {
				this.#debouncedUpdateAutocomplete();
			}
		} else {
			const currentLine = this.#state.lines[this.#state.cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
			if (this.#isInSlashAutocompleteContext()) {
				this.#tryTriggerAutocomplete();
			} else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
				this.#tryTriggerAutocomplete();
			} else if (textBeforeCursor.match(/#[^\s#]*$/)) {
				this.#tryTriggerAutocomplete();
			} else if (this.#textTriggersUrlAutocomplete(textBeforeCursor)) {
				this.#tryTriggerAutocomplete();
			}
		}
	}

	#setCursorCol(col: number): void {
		this.#state.cursorCol = col;
		this.#preferredVisualCol = null;
	}

	#moveToVisualLine(
		visualLines: Array<{ logicalLine: number; startCol: number; length: number }>,
		currentVisualLine: number,
		targetVisualLine: number,
	): void {
		const currentVL = visualLines[currentVisualLine];
		const targetVL = visualLines[targetVisualLine];

		if (currentVL && targetVL) {
			const sourceLine = this.#state.lines[currentVL.logicalLine] || "";
			const sourceText = sourceLine.slice(currentVL.startCol, currentVL.startCol + currentVL.length);
			const currentVisualCol = visualColAtOffset(sourceText, this.#state.cursorCol - currentVL.startCol);

			const isLastSourceSegment =
				currentVisualLine === visualLines.length - 1 ||
				visualLines[currentVisualLine + 1]?.logicalLine !== currentVL.logicalLine;
			const sourceMaxVisualCol = maxSegmentVisualCol(sourceText, isLastSourceSegment);

			const isLastTargetSegment =
				targetVisualLine === visualLines.length - 1 ||
				visualLines[targetVisualLine + 1]?.logicalLine !== targetVL.logicalLine;
			const targetLine = this.#state.lines[targetVL.logicalLine] || "";
			const targetText = targetLine.slice(targetVL.startCol, targetVL.startCol + targetVL.length);
			const targetMaxVisualCol = maxSegmentVisualCol(targetText, isLastTargetSegment);

			const moveToVisualCol = this.#computeVerticalMoveColumn(
				currentVisualCol,
				sourceMaxVisualCol,
				targetMaxVisualCol,
			);

			this.#state.cursorLine = targetVL.logicalLine;
			const targetCol = targetVL.startCol + offsetAtVisualCol(targetText, moveToVisualCol);
			this.#state.cursorCol = Math.min(targetCol, targetLine.length);
		}
	}

	#computeVerticalMoveColumn(
		currentVisualCol: number,
		sourceMaxVisualCol: number,
		targetMaxVisualCol: number,
	): number {
		const hasPreferred = this.#preferredVisualCol !== null;
		const cursorInMiddle = currentVisualCol < sourceMaxVisualCol;
		const targetTooShort = targetMaxVisualCol < currentVisualCol;

		if (!hasPreferred || cursorInMiddle) {
			if (targetTooShort) {
				this.#preferredVisualCol = currentVisualCol;
				return targetMaxVisualCol;
			}
			this.#preferredVisualCol = null;
			return currentVisualCol;
		}

		const targetCantFitPreferred = targetMaxVisualCol < this.#preferredVisualCol!;
		if (targetTooShort || targetCantFitPreferred) {
			return targetMaxVisualCol;
		}

		const result = this.#preferredVisualCol!;
		this.#preferredVisualCol = null;
		return result;
	}

	#moveToLineStart(): void {
		this.#resetKillSequence();
		this.#setCursorCol(0);
	}

	#moveToLineEnd(): void {
		this.#resetKillSequence();
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		this.#setCursorCol(currentLine.length);
	}

	#moveToMessageStart(): void {
		this.#resetKillSequence();
		this.#state.cursorLine = 0;
		this.#setCursorCol(0);
	}

	#moveToMessageEnd(): void {
		this.#resetKillSequence();
		this.#state.cursorLine = this.#state.lines.length - 1;
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		this.#setCursorCol(currentLine.length);
	}

	#resetKillSequence(): void {
		this.#lastAction = null;
	}

	#withUndoSuspended<T>(fn: () => T): T {
		const wasSuspended = this.#suspendUndo;
		this.#suspendUndo = true;
		try {
			return fn();
		} finally {
			this.#suspendUndo = wasSuspended;
		}
	}

	#recordUndoState(): void {
		if (this.#suspendUndo) return;
		this.#undoStack.push(structuredClone(this.#state));
		if (this.#undoStack.length > MAX_UNDO_STACK) {
			this.#undoStack.shift();
		}
	}

	#applyUndo(): void {
		const snapshot = this.#undoStack.pop();
		if (!snapshot) return;

		this.#historyIndex = -1;
		this.#resetKillSequence();
		this.#preferredVisualCol = null;
		Object.assign(this.#state, snapshot);

		if (this.onChange) {
			this.onChange(this.getText());
		}

		if (this.#autocompleteState) {
			this.#debouncedUpdateAutocomplete();
		} else {
			const currentLine = this.#state.lines[this.#state.cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
			if (this.#isInSlashAutocompleteContext()) {
				this.#tryTriggerAutocomplete();
			} else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
				this.#tryTriggerAutocomplete();
			} else if (textBeforeCursor.match(/#[^\s#]*$/)) {
				this.#tryTriggerAutocomplete();
			} else if (this.#textTriggersUrlAutocomplete(textBeforeCursor)) {
				this.#tryTriggerAutocomplete();
			}
		}
	}

	#matchesTransientUndoSnapshot(
		snapshot: EditorState,
		transientText: string,
		transientStartCol: number,
		beforeTransient: string,
		afterTransient: string,
	): boolean {
		if (snapshot.cursorLine !== this.#state.cursorLine) return false;
		if (snapshot.lines.length !== this.#state.lines.length) return false;

		const transientLength = snapshot.cursorCol - transientStartCol;
		if (transientLength < 0 || transientLength >= transientText.length) return false;

		for (let i = 0; i < snapshot.lines.length; i++) {
			if (i === this.#state.cursorLine) continue;
			if (snapshot.lines[i] !== this.#state.lines[i]) return false;
		}

		return (
			snapshot.lines[snapshot.cursorLine] ===
			beforeTransient + transientText.slice(0, transientLength) + afterTransient
		);
	}

	#recordKill(text: string, direction: "forward" | "backward", accumulate = this.#lastAction === "kill"): void {
		if (!text) return;
		this.#killRing.push(text, { prepend: direction === "backward", accumulate });
		this.#lastAction = "kill";
	}

	#insertTextAtCursor(text: string): void {
		this.#historyIndex = -1;
		this.#resetKillSequence();
		this.#recordUndoState();

		const normalized = text.replace(/\r\n?/g, "\n");
		const lines = normalized.split("\n");

		if (lines.length === 1) {
			const line = this.#state.lines[this.#state.cursorLine] || "";
			const before = line.slice(0, this.#state.cursorCol);
			const after = line.slice(this.#state.cursorCol);
			this.#state.lines[this.#state.cursorLine] = before + normalized + after;
			this.#setCursorCol(this.#state.cursorCol + normalized.length);
		} else {
			const currentLine = this.#state.lines[this.#state.cursorLine] || "";
			const beforeCursor = currentLine.slice(0, this.#state.cursorCol);
			const afterCursor = currentLine.slice(this.#state.cursorCol);

			const newLines: string[] = [];
			for (let i = 0; i < this.#state.cursorLine; i++) {
				newLines.push(this.#state.lines[i] || "");
			}

			newLines.push(beforeCursor + (lines[0] || ""));
			for (let i = 1; i < lines.length - 1; i++) {
				newLines.push(lines[i] || "");
			}
			newLines.push((lines[lines.length - 1] || "") + afterCursor);

			for (let i = this.#state.cursorLine + 1; i < this.#state.lines.length; i++) {
				newLines.push(this.#state.lines[i] || "");
			}

			this.#state.lines = newLines;
			this.#state.cursorLine += lines.length - 1;
			this.#setCursorCol((lines[lines.length - 1] || "").length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
		this.#retriggerAutocompleteAtCursor();
	}

	#yankFromKillRing(): void {
		const text = this.#killRing.peek();
		if (!text) return;
		this.#insertTextAtCursor(text);
		this.#lastAction = "yank";
	}

	#yankPop(): void {
		if (this.#lastAction !== "yank") return;
		if (this.#killRing.length <= 1) return;

		this.#historyIndex = -1;
		this.#recordUndoState();

		this.#withUndoSuspended(() => {
			if (!this.#deleteYankedText()) return;
			this.#killRing.rotate();
			const text = this.#killRing.peek();
			if (text) {
				this.#insertTextAtCursor(text);
			}
		});

		this.#lastAction = "yank";
	}

	#deleteYankedText(): boolean {
		const yankedText = this.#killRing.peek();
		if (!yankedText) return false;

		const yankLines = yankedText.split("\n");
		const endLine = this.#state.cursorLine;
		const endCol = this.#state.cursorCol;
		const startLine = endLine - (yankLines.length - 1);
		if (startLine < 0) return false;

		if (yankLines.length === 1) {
			const line = this.#state.lines[endLine] ?? "";
			const startCol = endCol - yankedText.length;
			if (startCol < 0) return false;
			if (line.slice(startCol, endCol) !== yankedText) return false;

			this.#state.lines[endLine] = line.slice(0, startCol) + line.slice(endCol);
			this.#state.cursorLine = endLine;
			this.#setCursorCol(startCol);
			return true;
		}

		const firstInserted = yankLines[0] ?? "";
		const lastInserted = yankLines[yankLines.length - 1] ?? "";
		const firstLineText = this.#state.lines[startLine] ?? "";
		const lastLineText = this.#state.lines[endLine] ?? "";

		if (!firstLineText.endsWith(firstInserted)) return false;
		if (endCol !== lastInserted.length) return false;
		if (lastLineText.slice(0, endCol) !== lastInserted) return false;

		const startCol = firstLineText.length - firstInserted.length;
		if (startCol < 0) return false;

		const suffix = lastLineText.slice(endCol);
		const newLine = firstLineText.slice(0, startCol) + suffix;

		this.#state.lines.splice(startLine, yankLines.length, newLine);
		this.#state.cursorLine = startLine;
		this.#setCursorCol(startCol);
		return true;
	}

	#deleteToStartOfLine(): void {
		this.#historyIndex = -1; // Exit history browsing mode
		this.#recordUndoState();

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		let deletedText = "";

		if (this.#state.cursorCol > 0) {
			const { end } = this.#expandRangeOverAtomicTokens(currentLine, 0, this.#state.cursorCol);
			deletedText = currentLine.slice(0, end);
			this.#state.lines[this.#state.cursorLine] = currentLine.slice(end);
			this.#setCursorCol(0);
		} else if (this.#state.cursorLine > 0) {
			deletedText = "\n";
			const previousLine = this.#state.lines[this.#state.cursorLine - 1] || "";
			this.#state.lines[this.#state.cursorLine - 1] = previousLine + currentLine;
			this.#state.lines.splice(this.#state.cursorLine, 1);
			this.#state.cursorLine--;
			this.#setCursorCol(previousLine.length);
		}

		this.#recordKill(deletedText, "backward");

		if (this.onChange) {
			this.onChange(this.getText());
		}
		this.#retriggerAutocompleteAtCursor();
	}

	#deleteToEndOfLine(): void {
		this.#historyIndex = -1; // Exit history browsing mode
		this.#recordUndoState();

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		let deletedText = "";

		if (this.#state.cursorCol < currentLine.length) {
			const { start } = this.#expandRangeOverAtomicTokens(currentLine, this.#state.cursorCol, currentLine.length);
			deletedText = currentLine.slice(start);
			this.#state.lines[this.#state.cursorLine] = currentLine.slice(0, start);
			if (start < this.#state.cursorCol) {
				this.#setCursorCol(start);
			}
		} else if (this.#state.cursorLine < this.#state.lines.length - 1) {
			const nextLine = this.#state.lines[this.#state.cursorLine + 1] || "";
			deletedText = "\n";
			this.#state.lines[this.#state.cursorLine] = currentLine + nextLine;
			this.#state.lines.splice(this.#state.cursorLine + 1, 1);
		}

		this.#recordKill(deletedText, "forward");

		if (this.onChange) {
			this.onChange(this.getText());
		}
		this.#retriggerAutocompleteAtCursor();
	}

	#deleteWordBackwards(): void {
		this.#historyIndex = -1; // Exit history browsing mode
		this.#recordUndoState();

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";

		if (this.#state.cursorCol === 0) {
			if (this.#state.cursorLine > 0) {
				this.#recordKill("\n", "backward");
				const previousLine = this.#state.lines[this.#state.cursorLine - 1] || "";
				this.#state.lines[this.#state.cursorLine - 1] = previousLine + currentLine;
				this.#state.lines.splice(this.#state.cursorLine, 1);
				this.#state.cursorLine--;
				this.#setCursorCol(previousLine.length);
			}
		} else {
			const oldCursorCol = this.#state.cursorCol;
			this.#moveWordBackwards();
			const range = this.#expandRangeOverAtomicTokens(currentLine, this.#state.cursorCol, oldCursorCol);

			const deletedText = currentLine.slice(range.start, range.end);
			this.#state.lines[this.#state.cursorLine] = currentLine.slice(0, range.start) + currentLine.slice(range.end);
			this.#setCursorCol(range.start);
			this.#recordKill(deletedText, "backward");
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
		this.#retriggerAutocompleteAtCursor();
	}

	#deleteWordForwards(): void {
		this.#historyIndex = -1; // Exit history browsing mode
		this.#recordUndoState();

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";

		if (this.#state.cursorCol >= currentLine.length) {
			if (this.#state.cursorLine < this.#state.lines.length - 1) {
				this.#recordKill("\n", "forward");
				const nextLine = this.#state.lines[this.#state.cursorLine + 1] || "";
				this.#state.lines[this.#state.cursorLine] = currentLine + nextLine;
				this.#state.lines.splice(this.#state.cursorLine + 1, 1);
			}
		} else {
			const oldCursorCol = this.#state.cursorCol;
			this.#moveWordForwards();
			const range = this.#expandRangeOverAtomicTokens(currentLine, oldCursorCol, this.#state.cursorCol);

			const deletedText = currentLine.slice(range.start, range.end);
			this.#state.lines[this.#state.cursorLine] = currentLine.slice(0, range.start) + currentLine.slice(range.end);
			this.#setCursorCol(range.start);
			this.#recordKill(deletedText, "forward");
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
		this.#retriggerAutocompleteAtCursor();
	}

	#handleForwardDelete(): void {
		this.#historyIndex = -1; // Exit history browsing mode
		this.#resetKillSequence();
		this.#recordUndoState();

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";

		if (this.#state.cursorCol < currentLine.length) {
			const token = this.#atomicTokenAt(currentLine, this.#state.cursorCol);
			if (token !== undefined) {
				this.#state.lines[this.#state.cursorLine] =
					currentLine.slice(0, token.start) + currentLine.slice(token.end);
				this.#setCursorCol(token.start);
			} else {
				const afterCursor = currentLine.slice(this.#state.cursorCol);

				let firstGrapheme = "";
				for (const seg of segmenter.segment(afterCursor)) {
					firstGrapheme = seg.segment;
					break;
				}
				const graphemeLength = firstGrapheme.length || 1;

				const before = currentLine.slice(0, this.#state.cursorCol);
				const after = currentLine.slice(this.#state.cursorCol + graphemeLength);
				this.#state.lines[this.#state.cursorLine] = before + after;
			}
		} else if (this.#state.cursorLine < this.#state.lines.length - 1) {
			const nextLine = this.#state.lines[this.#state.cursorLine + 1] || "";
			this.#state.lines[this.#state.cursorLine] = currentLine + nextLine;
			this.#state.lines.splice(this.#state.cursorLine + 1, 1);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}

		if (this.#autocompleteState) {
			this.#debouncedUpdateAutocomplete();
		} else {
			const currentLine = this.#state.lines[this.#state.cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
			if (this.#isInSlashAutocompleteContext()) {
				this.#tryTriggerAutocomplete();
			} else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
				this.#tryTriggerAutocomplete();
			} else if (textBeforeCursor.match(/#[^\s#]*$/)) {
				this.#tryTriggerAutocomplete();
			} else if (this.#textTriggersUrlAutocomplete(textBeforeCursor)) {
				this.#tryTriggerAutocomplete();
			}
		}
	}

	#buildVisualLineMap(width: number): Array<{ logicalLine: number; startCol: number; length: number }> {
		const visualLines: Array<{ logicalLine: number; startCol: number; length: number }> = [];

		for (let i = 0; i < this.#state.lines.length; i++) {
			const line = this.#state.lines[i] || "";
			const lineVisWidth = visibleWidth(line);
			if (line.length === 0) {
				visualLines.push({ logicalLine: i, startCol: 0, length: 0 });
			} else if (lineVisWidth <= width) {
				visualLines.push({ logicalLine: i, startCol: 0, length: line.length });
			} else {
				const chunks = this.#wrapLine(line, width);
				for (let ci = 0; ci < chunks.length; ci++) {
					const chunk = chunks[ci]!;
					visualLines.push({
						logicalLine: i,
						startCol: chunk.startIndex,
						length: chunk.endIndex - chunk.startIndex,
					});
				}
			}
		}

		return visualLines;
	}

	#findCurrentVisualLine(visualLines: Array<{ logicalLine: number; startCol: number; length: number }>): number {
		for (let i = 0; i < visualLines.length; i++) {
			const vl = visualLines[i];
			if (!vl) continue;
			if (vl.logicalLine === this.#state.cursorLine) {
				const colInSegment = this.#state.cursorCol - vl.startCol;
				const isLastSegmentOfLine =
					i === visualLines.length - 1 || visualLines[i + 1]?.logicalLine !== vl.logicalLine;
				const isFirstSegmentOfLine = i === 0 || visualLines[i - 1]?.logicalLine !== vl.logicalLine;
				if (
					(colInSegment >= 0 || isFirstSegmentOfLine) &&
					(colInSegment < vl.length || (isLastSegmentOfLine && colInSegment <= vl.length))
				) {
					return i;
				}
			}
		}
		return visualLines.length - 1;
	}

	#moveCursor(deltaLine: number, deltaCol: number): void {
		this.#resetKillSequence();
		const visualLines = this.#buildVisualLineMap(this.#lastLayoutWidth);
		const currentVisualLine = this.#findCurrentVisualLine(visualLines);

		if (deltaLine !== 0) {
			const targetVisualLine = currentVisualLine + deltaLine;

			if (targetVisualLine >= 0 && targetVisualLine < visualLines.length) {
				this.#moveToVisualLine(visualLines, currentVisualLine, targetVisualLine);
			}
		}

		if (deltaCol !== 0) {
			const currentLine = this.#state.lines[this.#state.cursorLine] || "";

			if (deltaCol > 0) {
				if (this.#state.cursorCol < currentLine.length) {
					const afterCursor = currentLine.slice(this.#state.cursorCol);
					let firstGrapheme = "";
					for (const seg of segmenter.segment(afterCursor)) {
						firstGrapheme = seg.segment;
						break;
					}
					this.#setCursorCol(this.#state.cursorCol + (firstGrapheme.length || 1));
				} else if (this.#state.cursorLine < this.#state.lines.length - 1) {
					this.#state.cursorLine++;
					this.#setCursorCol(0);
				} else {
					const currentVL = visualLines[currentVisualLine];
					if (currentVL) {
						const segmentText = currentLine.slice(currentVL.startCol, currentVL.startCol + currentVL.length);
						this.#preferredVisualCol = visualColAtOffset(segmentText, this.#state.cursorCol - currentVL.startCol);
					}
				}
			} else {
				if (this.#state.cursorCol > 0) {
					const beforeCursor = currentLine.slice(0, this.#state.cursorCol);
					let lastGrapheme = "";
					for (const seg of segmenter.segment(beforeCursor)) lastGrapheme = seg.segment;
					this.#setCursorCol(this.#state.cursorCol - (lastGrapheme.length || 1));
				} else if (this.#state.cursorLine > 0) {
					this.#state.cursorLine--;
					const prevLine = this.#state.lines[this.#state.cursorLine] || "";
					this.#setCursorCol(prevLine.length);
				}
			}
		}
	}

	#pageScroll(direction: -1 | 1): void {
		this.#resetKillSequence();
		const visualLines = this.#buildVisualLineMap(this.#lastLayoutWidth);
		const currentVisualLine = this.#findCurrentVisualLine(visualLines);
		const step = this.#getPageScrollStep(visualLines.length);
		const targetVisualLine = clampLow(currentVisualLine + direction * step, 0, visualLines.length - 1);
		if (targetVisualLine === currentVisualLine) return;
		this.#moveToVisualLine(visualLines, currentVisualLine, targetVisualLine);
	}

	#moveWordBackwards(): void {
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";

		if (this.#state.cursorCol === 0) {
			if (this.#state.cursorLine > 0) {
				this.#state.cursorLine--;
				const prevLine = this.#state.lines[this.#state.cursorLine] || "";
				this.#setCursorCol(prevLine.length);
			}
			return;
		}

		this.#setCursorCol(moveWordLeft(currentLine, this.#state.cursorCol));
	}

	#jumpToChar(char: string, direction: "forward" | "backward"): void {
		this.#resetKillSequence();
		const isForward = direction === "forward";
		const lines = this.#state.lines;

		const end = isForward ? lines.length : -1;
		const step = isForward ? 1 : -1;

		for (let lineIdx = this.#state.cursorLine; lineIdx !== end; lineIdx += step) {
			const line = lines[lineIdx] || "";
			const isCurrentLine = lineIdx === this.#state.cursorLine;

			const searchFrom = isCurrentLine
				? isForward
					? this.#state.cursorCol + 1
					: this.#state.cursorCol - 1
				: undefined;

			const idx = isForward ? line.indexOf(char, searchFrom) : line.lastIndexOf(char, searchFrom);

			if (idx !== -1) {
				this.#state.cursorLine = lineIdx;
				this.#setCursorCol(idx);
				return;
			}
		}
	}

	#moveWordForwards(): void {
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";

		if (this.#state.cursorCol >= currentLine.length) {
			if (this.#state.cursorLine < this.#state.lines.length - 1) {
				this.#state.cursorLine++;
				this.#setCursorCol(0);
			}
			return;
		}

		this.#setCursorCol(moveWordRight(currentLine, this.#state.cursorCol));
	}

	#hasOnlyWhitespaceBeforeCursorLine(): boolean {
		for (let i = 0; i < this.#state.cursorLine; i++) {
			if ((this.#state.lines[i] || "").trim() !== "") {
				return false;
			}
		}
		return true;
	}

	#isAtStartOfSubmittedMessage(): boolean {
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.#state.cursorCol);

		return this.#hasOnlyWhitespaceBeforeCursorLine() && (beforeCursor.trim() === "" || beforeCursor.trim() === "/");
	}

	#isInSubmittedSlashCommandContext(): boolean {
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.#state.cursorCol);
		return this.#hasOnlyWhitespaceBeforeCursorLine() && beforeCursor.trimStart().startsWith("/");
	}

	#isInMidPromptSkillSlashContext(): boolean {
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.#state.cursorCol);
		const slashStart = findTrailingSlashCommandStart(beforeCursor);
		if (slashStart === null) return false;
		if (this.#hasOnlyWhitespaceBeforeCursorLine() && findLeadingSlashCommandStart(beforeCursor) !== null)
			return false;
		return !this.#hasOnlyWhitespaceBeforeCursorLine() || beforeCursor.slice(0, slashStart).trim() !== "";
	}

	#isInSlashAutocompleteContext(): boolean {
		return this.#isInSubmittedSlashCommandContext() || this.#isInMidPromptSkillSlashContext();
	}

	#autocompletePrefixMatchesCursorText(currentTextBeforeCursor: string, item?: SelectItem | null): boolean {
		if (currentTextBeforeCursor === this.#autocompletePrefix) return true;

		if (item?.value.startsWith("skill:") && findTrailingSlashCommandStart(this.#autocompletePrefix) !== null) {
			const currentTrailingStart = findTrailingSlashCommandStart(currentTextBeforeCursor);
			if (currentTrailingStart !== null) {
				const token = currentTextBeforeCursor.slice(currentTrailingStart);
				if (!token.includes(" ") && !token.slice(1).includes("/")) {
					const lowerToken = token.slice(1).toLowerCase();
					if (midPromptSkillTokenMatches(lowerToken, item.value, item.description)) return true;
				}
			}
			return false;
		}

		if (findLeadingSlashCommandStart(this.#autocompletePrefix) !== null && !this.#selectedCompletionIsPath()) {
			const currentLeadingStart = findLeadingSlashCommandStart(currentTextBeforeCursor);
			if (currentLeadingStart !== null) {
				const token = currentTextBeforeCursor.slice(currentLeadingStart);
				if (!token.includes(" ") && !token.slice(1).includes("/")) return true;
			}
			return false;
		}

		if (this.#autocompletePrefix.startsWith("@")) {
			return /(?:^|\s)@[^\s]*$/.test(currentTextBeforeCursor);
		}

		return currentTextBeforeCursor.endsWith(this.#autocompletePrefix);
	}

	#selectedCompletionIsPath(): boolean {
		const selected = this.#autocompleteList?.getSelectedItem();
		if (!selected) return false;
		return selected.value.startsWith("/") || selected.value.startsWith('"');
	}

	#isSlashCommandNameAutocompleteSelection(): boolean {
		if (this.#autocompleteState !== "regular") {
			return false;
		}

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol).trimStart();
		return (
			this.#isInSubmittedSlashCommandContext() && textBeforeCursor.startsWith("/") && !textBeforeCursor.includes(" ")
		);
	}

	#isCompletedSlashCommandAtCursor(): boolean {
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		if (this.#state.cursorCol !== currentLine.length) {
			return false;
		}

		const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol).trimStart();
		return this.#isInSubmittedSlashCommandContext() && /^\/\S+ $/.test(textBeforeCursor);
	}

	#textTriggersUrlAutocomplete(textBeforeCursor: string): boolean {
		return /(?:^|[\s"'`(<=])[a-z][a-z0-9+.-]*:\/{1,2}[^\s"'`()<>]*$/i.test(textBeforeCursor);
	}

	async #tryTriggerAutocomplete(explicitTab: boolean = false): Promise<void> {
		if (!this.#autocompleteProvider) return;
		if (explicitTab) {
			const shouldTrigger =
				!this.#autocompleteProvider.shouldTriggerFileCompletion ||
				this.#autocompleteProvider.shouldTriggerFileCompletion(
					this.#state.lines,
					this.#state.cursorLine,
					this.#state.cursorCol,
				);
			if (!shouldTrigger) {
				return;
			}
		}

		const requestId = ++this.#autocompleteRequestId;

		const suggestions = await this.#autocompleteProvider.getSuggestions(
			this.#state.lines,
			this.#state.cursorLine,
			this.#state.cursorCol,
		);
		if (requestId !== this.#autocompleteRequestId) return;

		if (suggestions && Array.isArray(suggestions.items) && suggestions.items.length > 0) {
			this.#autocompletePrefix = suggestions.prefix;
			this.#autocompleteList = this.#createAutocompleteList(suggestions.prefix, suggestions.items);
			this.#autocompleteState = "regular";
			this.#autocompleteReveal?.arm();
			this.onAutocompleteUpdate?.();
		} else {
			this.#cancelAutocomplete();
			this.onAutocompleteUpdate?.();
		}
	}
	#createAutocompleteList(
		prefix: string,
		items: Array<{ value: string; label: string; description?: string; group?: string }>,
	): SelectList {
		const layout = prefix.startsWith("/") ? SLASH_COMMAND_SELECT_LIST_LAYOUT : AUTOCOMPLETE_SELECT_LIST_LAYOUT;
		return new SelectList(items, this.#autocompleteMaxVisible, this.#theme.selectList, layout);
	}

	async #handleTabCompletion(): Promise<void> {
		if (!this.#autocompleteProvider) return;

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.#state.cursorCol);

		if (this.#isInSubmittedSlashCommandContext() && !beforeCursor.trimStart().includes(" ")) {
			await this.#handleSlashCommandCompletion();
		} else if (this.#isInMidPromptSkillSlashContext()) {
			await this.#handleSlashCommandCompletion();
			if (!this.#autocompleteState) {
				await this.#forceFileAutocomplete();
			}
		} else {
			await this.#forceFileAutocomplete();
		}
	}
	async #handleSlashCommandCompletion(): Promise<void> {
		await this.#tryTriggerAutocomplete();
	}

	async #forceFileAutocomplete(): Promise<void> {
		if (!this.#autocompleteProvider) return;

		const getForceFileSuggestions = this.#autocompleteProvider.getForceFileSuggestions;
		if (typeof getForceFileSuggestions !== "function") {
			await this.#tryTriggerAutocomplete(true);
			return;
		}

		const requestId = ++this.#autocompleteRequestId;
		const suggestions = await getForceFileSuggestions.call(
			this.#autocompleteProvider,
			this.#state.lines,
			this.#state.cursorLine,
			this.#state.cursorCol,
		);
		if (requestId !== this.#autocompleteRequestId) return;

		if (suggestions && Array.isArray(suggestions.items) && suggestions.items.length > 0) {
			this.#autocompletePrefix = suggestions.prefix;
			this.#autocompleteList = this.#createAutocompleteList(suggestions.prefix, suggestions.items);
			this.#autocompleteState = "force";
			this.#autocompleteReveal?.arm();
			this.onAutocompleteUpdate?.();
		} else {
			this.#cancelAutocomplete();
			this.onAutocompleteUpdate?.();
		}
	}

	#acceptAutocompleteSelection(selected: SelectItem | null): void {
		const currentLine = this.#state.lines[this.#state.cursorLine] ?? "";
		const currentTextBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
		if (!this.#autocompletePrefixMatchesCursorText(currentTextBeforeCursor, selected)) {
			this.#cancelAutocomplete();
			return;
		}
		if (!selected || !this.#autocompleteProvider) return;
		const shouldChainSlashCommandAutocomplete = this.#isSlashCommandNameAutocompleteSelection();
		const result = this.#autocompleteProvider.applyCompletion(
			this.#state.lines,
			this.#state.cursorLine,
			this.#state.cursorCol,
			selected,
			this.#autocompletePrefix,
		);

		this.#state.lines = result.lines;
		this.#state.cursorLine = result.cursorLine;
		this.#setCursorCol(result.cursorCol);

		this.#cancelAutocomplete();
		this.onAutocompleteUpdate?.();

		if (this.onChange) {
			this.onChange(this.getText());
		}

		result.onApplied?.();

		if (shouldChainSlashCommandAutocomplete && this.#isCompletedSlashCommandAtCursor()) {
			void this.#tryTriggerAutocomplete();
		}
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (!event.leftClick) return;
		const list = this.#autocompleteList;
		if (this.#autocompleteState && list && this.#autocompleteRowStart >= 0) {
			const index = list.hitTest(line - this.#autocompleteRowStart);
			if (index !== undefined) {
				list.setSelectedIndex(index);
				this.#acceptAutocompleteSelection(list.getSelectedItem());
				return;
			}
		}
		this.#placeCaretAt(line, col);
	}

	#placeCaretAt(line: number, col: number): void {
		const row = line - this.#textRowStart;
		if (row < 0 || row >= this.#textRowCount) return;
		const visualLines = this.#buildVisualLineMap(this.#lastLayoutWidth);
		const target = visualLines[this.#textScrollOffset + row];
		if (!target) return;
		const logical = this.#state.lines[target.logicalLine] ?? "";
		const segment = logical.slice(target.startCol, target.startCol + target.length);
		const wanted = Math.max(0, col - this.#textColStart);
		this.#resetKillSequence();
		this.#preferredVisualCol = null;
		this.#state.cursorLine = target.logicalLine;
		this.#setCursorCol(target.startCol + offsetAtVisualCol(segment, wanted));
		if (this.#autocompleteState) this.#cancelAutocomplete(true);
	}

	#cancelAutocomplete(notifyCancel: boolean = false): void {
		const wasAutocompleting = this.#autocompleteState !== null;
		this.#clearAutocompleteTimeout();
		this.#autocompleteRequestId += 1;
		this.#autocompleteState = null;
		this.#autocompleteList = undefined;
		this.#autocompletePrefix = "";
		this.#autocompleteReveal?.disarm();
		if (notifyCancel && wasAutocompleting) {
			this.onAutocompleteCancel?.();
		}
	}

	isShowingAutocomplete(): boolean {
		return this.#autocompleteState !== null;
	}

	async #updateAutocomplete(): Promise<void> {
		if (!this.#autocompleteState || !this.#autocompleteProvider) return;

		if (this.#autocompleteState === "force") {
			this.#forceFileAutocomplete();
			return;
		}

		const requestId = ++this.#autocompleteRequestId;

		const suggestions = await this.#autocompleteProvider.getSuggestions(
			this.#state.lines,
			this.#state.cursorLine,
			this.#state.cursorCol,
		);
		if (requestId !== this.#autocompleteRequestId) return;

		if (suggestions && Array.isArray(suggestions.items) && suggestions.items.length > 0) {
			this.#autocompletePrefix = suggestions.prefix;
			this.#autocompleteList = this.#createAutocompleteList(suggestions.prefix, suggestions.items);
			this.onAutocompleteUpdate?.();
		} else {
			this.#cancelAutocomplete();
			this.onAutocompleteUpdate?.();
		}
	}

	#debouncedUpdateAutocomplete(): void {
		if (this.#autocompleteTimeout) {
			clearTimeout(this.#autocompleteTimeout);
		}
		this.#autocompleteTimeout = setTimeout(() => {
			this.#updateAutocomplete();
			this.#autocompleteTimeout = undefined;
		}, 100);
	}

	#clearAutocompleteTimeout(): void {
		if (this.#autocompleteTimeout) {
			clearTimeout(this.#autocompleteTimeout);
			this.#autocompleteTimeout = undefined;
		}
	}

	#getInlineHint(): string | null {
		if (this.#autocompleteState && this.#autocompleteList) {
			const selected = this.#autocompleteList.getSelectedItem();
			return selected?.hint ?? null;
		}

		if (this.#placeholder && this.#state.lines.length === 1 && this.#state.lines[0] === "") {
			return this.#placeholder;
		}

		if (this.#autocompleteProvider?.getInlineHint) {
			return this.#autocompleteProvider.getInlineHint(
				this.#state.lines,
				this.#state.cursorLine,
				this.#state.cursorCol,
			);
		}

		return null;
	}
}
