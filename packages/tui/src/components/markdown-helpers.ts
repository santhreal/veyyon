import { OSC66, sgrSequence } from "../ansi";
import { padding, sgrCarryAfter, visibleWidth, wrapTextWithAnsi } from "../utils";

export const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;
export function isOsc66Line(line: string): boolean {
	return line.includes(OSC66);
}
export function normalizeHtmlEntitiesForTerminal(raw: string): string {
	const parseCodePoint = (value: number): string => {
		if (Number.isFinite(value) && value >= 0 && value <= 0x10ffff) {
			try {
				return String.fromCodePoint(value);
			} catch (_) {}
		}
		return "";
	};

	return raw.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/gi, (match, entity) => {
		const lower = entity.toLowerCase();
		switch (lower) {
			case "nbsp":
				return " ";
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "quot":
				return '"';
			case "apos":
				return "'";
			case "amp":
				return "&";
			default: {
				if (lower.charCodeAt(0) === 0x23 && lower.charCodeAt(1) === 0x78) {
					return parseCodePoint(Number.parseInt(lower.slice(2), 16));
				}
				if (lower.charCodeAt(0) === 0x23) {
					return parseCodePoint(Number(lower.slice(1)));
				}
				return match;
			}
		}
	});
}
export interface HtmlListState {
	type: "ol" | "ul";
	next: number;
}
export interface HtmlNormalizationState {
	lists: HtmlListState[];
	openItems: boolean[];
	itemHasContent: boolean[];
}
export function createHtmlNormalizationState(): HtmlNormalizationState {
	return { lists: [], openItems: [], itemHasContent: [] };
}
export const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g;
export const HTML_TAG_REGEX = /<\/?(?:br|p|ol|ul|li|span|summary|text|code|hr|blockquote)\b(?:\s[^>]*)?\s*\/?>/gi;
export const BLOCK_HTML_REGEX = /<hr\b[^>]*\/?>|<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi;
export const HEADING_PREFIXES = ["# ", "## ", "### ", "#### ", "##### ", "###### "];
export function htmlTagName(tag: string): string {
	const match = /^<\/?\s*([A-Za-z][A-Za-z0-9:-]*)/.exec(tag);
	return match ? match[1].toLowerCase() : "";
}
function htmlOlStart(tag: string): number {
	const match = /\bstart\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+))/i.exec(tag);
	if (!match) return 1;
	return Number(match[1] ?? match[2] ?? match[3]);
}
function appendHtmlLineBreak(output: string, force: boolean = false): string {
	const trimmed = output.replace(/[ \t]+$/u, "");
	return !force && trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
}
function htmlListIndent(state: HtmlNormalizationState): string {
	return padding(Math.max(0, state.lists.length - 1) * 2);
}
function appendHtmlListBreak(output: string, state: HtmlNormalizationState): string {
	const indent = htmlListIndent(state);
	return output.endsWith(`${indent}\n`) ? output : appendHtmlLineBreak(output);
}
export function markCurrentHtmlItemContent(state: HtmlNormalizationState, text: string): void {
	if (text.trim() !== "" && state.itemHasContent.length > 0) {
		state.itemHasContent[state.itemHasContent.length - 1] = true;
	}
}
function isAtEmptyHtmlListItem(state: HtmlNormalizationState): boolean {
	const itemIndex = state.itemHasContent.length - 1;
	return state.openItems[itemIndex] === true && state.itemHasContent[itemIndex] !== true;
}
export function normalizeHtmlForTerminal(
	raw: string,
	state: HtmlNormalizationState = createHtmlNormalizationState(),
	codeHook?: (text: string) => string,
): string {
	let output = "";
	let lastIndex = 0;
	let inCode = false;
	const withoutComments = raw.replace(HTML_COMMENT_REGEX, "");

	for (const match of withoutComments.matchAll(HTML_TAG_REGEX)) {
		const tag = match[0];
		const index = match.index ?? 0;
		const textBeforeTag = normalizeHtmlEntitiesForTerminal(withoutComments.slice(lastIndex, index));
		const name = htmlTagName(tag);
		const isInlineTag = name === "span" || name === "summary" || name === "text";
		if (isInlineTag || inCode || textBeforeTag.trim() !== "") {
			output += inCode && codeHook ? codeHook(textBeforeTag) : textBeforeTag;
			markCurrentHtmlItemContent(state, textBeforeTag);
		}
		lastIndex = index + tag.length;

		const isClosing = /^<\//.test(tag);
		const isSelfClosing = /\/\s*>$/.test(tag);

		switch (name) {
			case "span":
			case "summary":
			case "text":
				break;
			case "code":
				if (isClosing) inCode = false;
				else if (!isSelfClosing) inCode = true;
				break;
			case "br":
			case "hr":
				output = appendHtmlLineBreak(output, true);
				break;
			case "p":
			case "blockquote":
				if (isClosing) {
					output = appendHtmlLineBreak(output);
				} else if (output.trim() !== "" && !output.endsWith("\n") && !isAtEmptyHtmlListItem(state)) {
					output = appendHtmlLineBreak(output);
				}
				break;
			case "ol":
				if (isClosing) {
					state.lists.pop();
					state.openItems.pop();
					state.itemHasContent.pop();
				} else if (!isSelfClosing) {
					if (state.openItems.length > 0 && state.openItems[state.openItems.length - 1]) {
						output = appendHtmlListBreak(output, state);
					}
					state.lists.push({ type: "ol", next: htmlOlStart(tag) });
					state.openItems.push(false);
					state.itemHasContent.push(false);
				}
				break;
			case "ul":
				if (isClosing) {
					state.lists.pop();
					state.openItems.pop();
					state.itemHasContent.pop();
				} else if (!isSelfClosing) {
					if (state.openItems.length > 0 && state.openItems[state.openItems.length - 1]) {
						output = appendHtmlListBreak(output, state);
					}
					state.lists.push({ type: "ul", next: 1 });
					state.openItems.push(false);
					state.itemHasContent.push(false);
				}
				break;
			case "li": {
				if (isClosing) {
					output = appendHtmlLineBreak(output);
					break;
				}
				if (state.openItems.length > 0) {
					const itemOpenIndex = state.openItems.length - 1;
					if (state.openItems[itemOpenIndex]) output = appendHtmlListBreak(output, state);
					state.openItems[itemOpenIndex] = true;
					state.itemHasContent[itemOpenIndex] = false;
				} else if (output.trim() !== "" && !output.endsWith("\n")) {
					output = appendHtmlLineBreak(output);
				}
				const list = state.lists[state.lists.length - 1];
				const indent = htmlListIndent(state);
				if (list?.type === "ol") {
					output += `${indent}${list.next}. `;
					list.next++;
				} else {
					output += `${indent}• `;
				}
				break;
			}
			default:
				output += tag;
				break;
		}
	}

	const remainingText = normalizeHtmlEntitiesForTerminal(withoutComments.slice(lastIndex));
	markCurrentHtmlItemContent(state, remainingText);
	return output + (inCode && codeHook ? codeHook(remainingText) : remainingText);
}
export function splitTerminalLines(text: string): string[] {
	const lines = text.split("\n");
	while (lines.length > 1 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}
export const TREE_GUIDE_CONTINUATION: Record<string, string> = {
	"│": "│",
	"┃": "┃",
	"║": "║",
	"├": "│",
	"┣": "┃",
	"╠": "║",
	"└": " ",
	"┗": " ",
	"╚": " ",
	"╰": " ",
	"─": " ",
	"━": " ",
	"═": " ",
	" ": " ",
};
export const TREE_GUIDE_ANCHOR_RE = /[│┃║├┣╠└┗╚╰]/;
export const TREE_BRANCH_CONNECTOR_RE = /[├┣╠└┗╚╰][─━═]/;
export const MIN_TREE_CONTENT_WIDTH = 8;
export const SGR_SEQUENCE_STICKY = sgrSequence("y");
export interface TreeGuidePrefix {
	end: number;
	codes: string;
	guides: string;
}
function matchTreeGuidePrefix(line: string): TreeGuidePrefix | undefined {
	let codes = "";
	let guides = "";
	let i = 0;
	while (i < line.length) {
		if (line.charCodeAt(i) === 0x1b) {
			SGR_SEQUENCE_STICKY.lastIndex = i;
			const match = SGR_SEQUENCE_STICKY.exec(line);
			if (!match) break;
			codes += match[0];
			i = SGR_SEQUENCE_STICKY.lastIndex;
			continue;
		}
		const char = line[i]!;
		if (!(char in TREE_GUIDE_CONTINUATION)) break;
		guides += char;
		i++;
	}
	if (i >= line.length || !TREE_BRANCH_CONNECTOR_RE.test(guides)) return undefined;
	return { end: i, codes, guides };
}
export function hangWrapTreeGuideLines(text: string, width: number): string[] | undefined {
	if (width < MIN_TREE_CONTENT_WIDTH || !TREE_GUIDE_ANCHOR_RE.test(text)) return undefined;

	const sourceLines = text.split("\n");
	const hangs = (line: string): TreeGuidePrefix | undefined => {
		if (visibleWidth(line) <= width) return undefined;
		const prefix = matchTreeGuidePrefix(line);
		if (!prefix) return undefined;
		if (width - visibleWidth(prefix.guides) < MIN_TREE_CONTENT_WIDTH) return undefined;
		return prefix;
	};
	let hasAny = false;
	for (let li = 0; li < sourceLines.length; li++) {
		if (hangs(sourceLines[li]!) !== undefined) {
			hasAny = true;
			break;
		}
	}
	if (!hasAny) return undefined;

	const out: string[] = [];
	let carry = "";
	for (let li = 0; li < sourceLines.length; li++) {
		const line = sourceLines[li]!;
		const prefix = hangs(line);
		if (!prefix) {
			out.push(carry ? carry + line : line);
			carry = sgrCarryAfter(carry, line);
			continue;
		}
		const activeCodes = carry + prefix.codes;
		const rows = wrapTextWithAnsi(activeCodes + line.slice(prefix.end), width - visibleWidth(prefix.guides));
		let hang = "";
		for (let gi = 0; gi < prefix.guides.length; gi++) hang += TREE_GUIDE_CONTINUATION[prefix.guides[gi]!] ?? " ";
		const hangShortfall = visibleWidth(prefix.guides) - visibleWidth(hang);
		if (hangShortfall > 0) hang += padding(hangShortfall);
		out.push(carry + line.slice(0, prefix.end) + rows[0]!.slice(activeCodes.length));
		for (let i = 1; i < rows.length; i++) {
			out.push(activeCodes + hang + rows[i]!);
		}
		carry = sgrCarryAfter(carry, line);
	}
	return out;
}

import { LRUCache } from "lru-cache/raw";
import { Marked, type Token, Tokenizer, type TokenizerAndRendererExtension, type Tokens } from "marked";
import { inlineMathSpanEnd, isBareMathEnvironment, latexToUnicode } from "../latex-to-unicode";
import type { SymbolTheme } from "../symbols";
import { TERMINAL } from "../terminal-capabilities";
import { encodeTextSized, getSegmenter } from "../utils";

export class StrictStrikethroughTokenizer extends Tokenizer {
	override del(src: string): Tokens.Del | undefined {
		const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
		if (!match) {
			return undefined;
		}

		const text = match[2];
		return {
			type: "del",
			raw: match[0],
			text,
			tokens: this.lexer.inlineTokens(text),
		};
	}
}

export const markdownParser = new Marked();
markdownParser.setOptions({
	tokenizer: new StrictStrikethroughTokenizer(),
});

export const CUSTOM_HR_START_REGEX = /(?:^|\n) {0,3}([-*_─━═=–—])[ \t]*(?:\1[ \t]*){2,}(?:\n+|$)/;
export const CUSTOM_HR_TOKENIZER_REGEX = /^ {0,3}([-*_─━═=–—])[ \t]*(?:\1[ \t]*){2,}(?:\n+|$)/;

export function getHrChar(char: string, hrChar: string): string {
	const isAscii = hrChar === "-";
	switch (char) {
		case "=":
			return "=";
		case "═":
			return isAscii ? "=" : "═";
		case "━":
			return isAscii ? "-" : "━";
		case "─":
			return isAscii ? "-" : "─";
		case "–":
			return isAscii ? "-" : "–";
		case "—":
			return isAscii ? "-" : "—";
		default:
			return hrChar;
	}
}

export const customHrExtension: TokenizerAndRendererExtension = {
	name: "customHr",
	level: "block",
	start(src) {
		const match = CUSTOM_HR_START_REGEX.exec(src);
		if (!match) return undefined;
		let idx = match.index;
		if (src.charCodeAt(idx) === 0x0a) {
			idx += 1;
		}
		return idx;
	},
	tokenizer(src) {
		const match = CUSTOM_HR_TOKENIZER_REGEX.exec(src);
		if (match) {
			return {
				type: "hr",
				raw: match[0],
			};
		}
		return undefined;
	},
	renderer() {
		return "";
	},
};

export const mathExtension: TokenizerAndRendererExtension = {
	name: "math",
	level: "inline",
	start(src) {
		const m = /\$|\\\(|\\\[/.exec(src);
		return m ? m.index : undefined;
	},
	tokenizer(src) {
		if (src.charCodeAt(0) === 0x24 && src.charCodeAt(1) === 0x24) {
			const end = src.indexOf("$$", 2);
			if (end !== -1 && src.slice(2, end).trim().length > 0) {
				return { type: "math", raw: src.slice(0, end + 2), text: src.slice(2, end), display: true };
			}
			return undefined;
		}
		if (src.charCodeAt(0) === 0x5c && src.charCodeAt(1) === 0x5b) {
			const end = src.indexOf("\\]", 2);
			if (end !== -1) return { type: "math", raw: src.slice(0, end + 2), text: src.slice(2, end), display: true };
			return undefined;
		}
		if (src.charCodeAt(0) === 0x5c && src.charCodeAt(1) === 0x28) {
			const end = src.indexOf("\\)", 2);
			if (end !== -1) return { type: "math", raw: src.slice(0, end + 2), text: src.slice(2, end), display: false };
			return undefined;
		}
		if (src.charCodeAt(0) === 0x24 /* $ */) {
			const end = inlineMathSpanEnd(src, 0);
			if (end !== -1) return { type: "math", raw: src.slice(0, end + 1), text: src.slice(1, end), display: false };
		}
		return undefined;
	},
	renderer(token) {
		return (token as { text?: string }).text ?? "";
	},
};

export const MATH_BLOCK_DOLLAR = /^ {0,3}\$\$[ \t]*\n([\s\S]+?)\n {0,3}\$\$[ \t]*(?:\n|$)/;
export const MATH_BLOCK_BRACKET = /^ {0,3}\\\[[ \t]*\n([\s\S]+?)\n {0,3}\\\][ \t]*(?:\n|$)/;
export const MATH_BLOCK_START = /(?:^|\n) {0,3}(?:\$\$|\\\[)[ \t]*\n/;
export const mathBlockExtension: TokenizerAndRendererExtension = {
	name: "mathBlock",
	level: "block",
	start(src) {
		const m = MATH_BLOCK_START.exec(src);
		return m ? m.index : undefined;
	},
	tokenizer(src) {
		const m = MATH_BLOCK_DOLLAR.exec(src) ?? MATH_BLOCK_BRACKET.exec(src);
		if (!m || m[1].trim().length === 0) return undefined;
		return { type: "math", raw: m[0], text: m[1], display: true };
	},
	renderer(token) {
		return (token as { text?: string }).text ?? "";
	},
};

export const BARE_ENV_BEGIN = /(?:^|\n)[ \t]{0,3}\\begin\{([A-Za-z]+\*?)\}/;
function bareMathEnvBlock(src: string): readonly [number, number] | null {
	const bm = BARE_ENV_BEGIN.exec(src);
	if (!bm || !isBareMathEnvironment(bm[1])) return null;
	const beginLineStart = bm.index === 0 ? 0 : bm.index + 1; // skip the matched leading `\n`
	const endToken = `\\end{${bm[1]}}`;
	const endAt = src.indexOf(endToken, bm.index);
	if (endAt === -1) return null;
	if (/\n[ \t]*\n/.test(src.slice(beginLineStart, endAt))) return null;
	let blockEnd = endAt + endToken.length;
	while (src.charCodeAt(blockEnd) === 0x20 || src.charCodeAt(blockEnd) === 0x09) blockEnd++;
	if (src.charCodeAt(blockEnd) === 0x0a) blockEnd++;
	let start = beginLineStart;
	if (start > 0 && src.charCodeAt(start - 1) === 0x0a) {
		const prevStart = src.lastIndexOf("\n", start - 2) + 1;
		const prevLine = src.slice(prevStart, start - 1);
		if (/[=([{]\s*$/.test(prevLine)) start = prevStart;
	}
	return [start, blockEnd];
}
export const mathEnvBlockExtension: TokenizerAndRendererExtension = {
	name: "mathEnvBlock",
	level: "block",
	start(src) {
		const r = bareMathEnvBlock(src);
		return r ? r[0] : undefined;
	},
	tokenizer(src) {
		const r = bareMathEnvBlock(src);
		if (r?.[0] !== 0) return undefined; // only consume when the block starts at offset 0
		const raw = src.slice(0, r[1]);
		const text = raw.replace(/\n[ \t]*$/, "");
		if (text.trim().length === 0) return undefined;
		return { type: "math", raw, text, display: true };
	},
	renderer(token) {
		return (token as { text?: string }).text ?? "";
	},
};
markdownParser.use({ extensions: [customHrExtension, mathBlockExtension, mathEnvBlockExtension, mathExtension] });

export const RENDER_CACHE_MAX = 256; // sane cap: ~256 distinct message × width combos
export const RENDER_CACHE_MAX_SIZE = 512 * 1024;
export const RENDER_CACHE_MAX_ENTRY_SIZE = 32 * 1024;
export const EMPTY_RENDER_LINES: readonly string[] = [];
export const renderCache = new LRUCache<string, readonly string[]>({
	max: RENDER_CACHE_MAX,
	maxSize: RENDER_CACHE_MAX_SIZE,
	maxEntrySize: RENDER_CACHE_MAX_ENTRY_SIZE,
	sizeCalculation: renderedLinesCacheSize,
});

function renderedLinesCacheSize(lines: readonly string[]): number {
	let size = lines.length;
	for (let i = 0; i < lines.length; i++) size += lines[i]!.length;
	return Math.max(1, size);
}

export const HAS_REF_DEF = /^ {0,3}\[(?:\\.|[^\]\\])+\]:/m;

export function canStreamLex(text: string): boolean {
	return !HAS_REF_DEF.test(text) && !text.includes("\r");
}

export const MAX_BLOCKQUOTE_MARKERS = 24;
export const MAX_LEADING_INDENT = 64;
export const OVER_NESTED = new RegExp(
	`(?:^|\\n)(?:[ \\t]*>){${MAX_BLOCKQUOTE_MARKERS + 1},}|(?:^|\\n)[ \\t]{${MAX_LEADING_INDENT + 1},}\\S`,
);
export const BLOCKQUOTE_CAP = new RegExp(`^((?:[ \\t]*>){${MAX_BLOCKQUOTE_MARKERS}})(?:[ \\t]*>)+`, "gm");
export const INDENT_CAP = new RegExp(`^([ \\t]{${MAX_LEADING_INDENT}})[ \\t]+(?=\\S)`, "gm");

export function capMarkdownNesting(text: string): string {
	if (!OVER_NESTED.test(text)) return text;
	return text.replace(BLOCKQUOTE_CAP, "$1").replace(INDENT_CAP, "$1");
}

export function clearRenderCache(): void {
	renderCache.clear();
}

export const themeObjectIds = new WeakMap<object, number>();
export let nextObjectId = 0;
export function objectId(o: object): number {
	let id = themeObjectIds.get(o);
	if (id === undefined) {
		id = nextObjectId++;
		themeObjectIds.set(o, id);
	}
	return id;
}

export interface DefaultTextStyle {
	color?: (text: string) => string;
	bgColor?: (text: string) => string;
	bold?: boolean;
	italic?: boolean;
	strikethrough?: boolean;
	underline?: boolean;
}

export interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	codeBlockFence?: (lang: string | undefined, pos: "open" | "close") => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
	highlightCode?: (code: string, lang?: string) => string[];
	resolveMermaidAscii?: (source: string, maxWidth?: number) => string | null;
	symbols: SymbolTheme;
}

export interface InlineStyleContext {
	applyText: (text: string) => string;
	stylePrefix: string;
}

export type ListToken = Token & { items: Array<{ tokens?: Token[] }>; ordered: boolean; start?: number };
export type TableCellToken = { tokens?: Token[] };
export type TableAlign = "left" | "center" | "right" | null;
export type TableToken = Token & {
	header: TableCellToken[];
	rows: TableCellToken[][];
	align?: TableAlign[];
	raw?: string;
};

export function alignCellText(text: string, width: number, align: TableAlign): string {
	const slack = Math.max(0, width - visibleWidth(text));
	if (slack === 0) return text;
	if (align === "right") return padding(slack) + text;
	if (align === "center") {
		const left = Math.floor(slack / 2);
		return padding(left) + text + padding(slack - left);
	}
	return text + padding(slack);
}

export function formatHyperlink(text: string, target: string): string {
	if (!TERMINAL.hyperlinks || !target) {
		return text;
	}

	const safeTarget = target.replaceAll("\x1b", "").replaceAll("\x07", "");
	if (!safeTarget) {
		return text;
	}

	return `\x1b]8;;${safeTarget}\x07${text}\x1b]8;;\x07`;
}

function isAsciiTextSizingPayload(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x20 || code > 0x7e) return false;
	}
	return true;
}

export function encodeTextSizedHeading(text: string, scale: 1 | 2 | 3): string {
	let out = "";
	let asciiRun = "";
	const flushAscii = () => {
		if (asciiRun === "") return;
		out += encodeTextSized(asciiRun, { scale });
		asciiRun = "";
	};

	for (const { segment } of getSegmenter().segment(text)) {
		if (isAsciiTextSizingPayload(segment)) {
			asciiRun += segment;
			continue;
		}
		flushAscii();
		out += encodeTextSized(segment, { scale, widthCells: visibleWidth(segment) });
	}
	flushAscii();
	return out;
}

export const MATH_NEWLINES = /\n+/g;

export function isMathToken(token: Token): token is Token & { text: string; display: boolean } {
	return (token as { type: string }).type === "math";
}

export function renderMathToken(text: string): string {
	return latexToUnicode(text).replace(MATH_NEWLINES, " ");
}
