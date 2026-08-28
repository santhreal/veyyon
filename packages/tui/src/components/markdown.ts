import { LRUCache } from "lru-cache/raw";
import { Marked, type Token, Tokenizer, type TokenizerAndRendererExtension, type Tokens } from "marked";
import { OSC66, SGR_RESET, sgrSequence } from "../ansi";
import { latexToBlock } from "../latex-block";
import { inlineMathSpanEnd, isBareMathEnvironment, latexToUnicode } from "../latex-to-unicode";
import type { SymbolTheme } from "../symbols";
import { TERMINAL } from "../terminal-capabilities";
import type { Component } from "../tui";
import {
	applyBackgroundToLine,
	Ellipsis,
	encodeTextSized,
	getPaddingX,
	getSegmenter,
	padding,
	replaceTabs,
	sgrCarryAfter,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../utils";

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

// OSC 66 (Kitty text-sizing) heading spans are emitted as a single indivisible
// unit by the H1 render path. Like image-protocol lines, they must bypass
// ANSI wrapping and width padding: re-wrapping splits/normalizes the sized span
// (recomputing the explicit `w=` cell count and hoisting SGR out of the OSC
// payload), and padding would append trailing cells past the doubled glyph.

function isOsc66Line(line: string): boolean {
	return line.includes(OSC66);
}

function normalizeHtmlEntitiesForTerminal(raw: string): string {
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

interface HtmlListState {
	type: "ol" | "ul";
	next: number;
}

interface HtmlNormalizationState {
	lists: HtmlListState[];
	openItems: boolean[];
	itemHasContent: boolean[];
}

function createHtmlNormalizationState(): HtmlNormalizationState {
	return { lists: [], openItems: [], itemHasContent: [] };
}

const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g;
const HTML_TAG_REGEX = /<\/?(?:br|p|ol|ul|li|span|summary|text|code|hr|blockquote)\b(?:\s[^>]*)?\s*\/?>/gi;
// Block-level HTML that needs structural (not just textual) rendering: standalone
// `<hr>` becomes a rule and balanced `<blockquote>…</blockquote>` renders with
// quote styling. Group 1 captures blockquote inner content; it is undefined for hr.
const BLOCK_HTML_REGEX = /<hr\b[^>]*\/?>|<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi;
const HEADING_PREFIXES = ["# ", "## ", "### ", "#### ", "##### ", "###### "];

function htmlTagName(tag: string): string {
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

function markCurrentHtmlItemContent(state: HtmlNormalizationState, text: string): void {
	if (text.trim() !== "" && state.itemHasContent.length > 0) {
		state.itemHasContent[state.itemHasContent.length - 1] = true;
	}
}

function isAtEmptyHtmlListItem(state: HtmlNormalizationState): boolean {
	const itemIndex = state.itemHasContent.length - 1;
	return state.openItems[itemIndex] === true && state.itemHasContent[itemIndex] !== true;
}

function normalizeHtmlForTerminal(
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
		// Most tags handled here are block-level. Inline contexts — span, summary,
		// text, and the content inside a `<code>` run — keep their surrounding
		// whitespace verbatim because it is significant. For block-level tags, HTML formatting
		// whitespace between tags (e.g. the newlines and indentation in
		// pretty-printed `<ul>\n  <li>…`) is not rendered content; appending it
		// literally would leak source indentation before bullets and blank rows
		// between items, so a whitespace-only slice is dropped. Text inside a
		// `<code>` run is routed through `codeHook` so the inline-code theme is
		// applied without leaking the raw `<code>`/`</code>` tags.
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

function splitTerminalLines(text: string): string[] {
	const lines = text.split("\n");
	while (lines.length > 1 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

// Tree-guide hanging wrap
//
// Models routinely emit box-drawing trees ("├── item") inside plain
// paragraphs — directory layouts, decision trees. The lexer sees those lines
// as ordinary prose, so the generic wrap pass restarts wrapped continuations
// at column 0 and visually shears the tree apart (doubly fast for CJK text,
// where every glyph is two cells wide). Mirror the guide semantics of
// `tree(1)` / rich.tree instead: wrap the node text within the cells that
// remain after the guide prefix, and indent every continuation row under the
// node text — branch glyphs swap to their pass-through form (`├` → `│`,
// `└` → blank) so the rails of still-open ancestors stay visually joined.

const TREE_GUIDE_CONTINUATION: Record<string, string> = {
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

const TREE_GUIDE_ANCHOR_RE = /[│┃║├┣╠└┗╚╰]/;

const TREE_BRANCH_CONNECTOR_RE = /[├┣╠└┗╚╰][─━═]/;

const MIN_TREE_CONTENT_WIDTH = 8;

const SGR_SEQUENCE_STICKY = sgrSequence("y");

interface TreeGuidePrefix {
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

function hangWrapTreeGuideLines(text: string, width: number): string[] | undefined {
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
		// Re-play the SGR state ahead of the node text so the wrapper carries
		// it onto every continuation row; the codes are zero-width, so measured
		// row widths are unaffected.
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

class StrictStrikethroughTokenizer extends Tokenizer {
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

const markdownParser = new Marked();
markdownParser.setOptions({
	tokenizer: new StrictStrikethroughTokenizer(),
});

// Math spans (`$$…$$`, `\[…\]`, `$…$`, `\(…\)`) are tokenized as a dedicated
// `math` inline token before markdown's escape/emphasis/link rules run, so
// backslash commands (`\frac`, `\alpha`) and intraword underscores (`x_i`)
// survive intact instead of being mangled or split. The `$…$` form uses
// pandoc's anti-currency heuristic (`inlineMathSpanEnd`) so "$5 and $10" is
// never math. Inline extensions run before marked's escape tokenizer, so
// `\(…\)` becomes math while a genuinely escaped `\$` is left to `escape` and
// renders as a literal dollar.
const CUSTOM_HR_START_REGEX = /(?:^|\n) {0,3}([-*_─━═=–—])[ \t]*(?:\1[ \t]*){2,}(?:\n+|$)/;
const CUSTOM_HR_TOKENIZER_REGEX = /^ {0,3}([-*_─━═=–—])[ \t]*(?:\1[ \t]*){2,}(?:\n+|$)/;

function getHrChar(char: string, hrChar: string): string {
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

const customHrExtension: TokenizerAndRendererExtension = {
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

const mathExtension: TokenizerAndRendererExtension = {
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

// Display math blocks: opening `$$` / `\[` and closing `$$` / `\]` each alone on
// their own line (≤3 leading spaces). Matched at the block level — before
// paragraph/list parsing — so a multi-line equation (e.g. a matrix with `\\`
// row breaks) renders across several lines instead of being collapsed onto one,
// and blank lines inside the block don't split it. The own-line requirement
// keeps inline `$$…$$` inside prose for the inline tokenizer above.
const MATH_BLOCK_DOLLAR = /^ {0,3}\$\$[ \t]*\n([\s\S]+?)\n {0,3}\$\$[ \t]*(?:\n|$)/;
const MATH_BLOCK_BRACKET = /^ {0,3}\\\[[ \t]*\n([\s\S]+?)\n {0,3}\\\][ \t]*(?:\n|$)/;
const MATH_BLOCK_START = /(?:^|\n) {0,3}(?:\$\$|\\\[)[ \t]*\n/;
const mathBlockExtension: TokenizerAndRendererExtension = {
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

// Bare (delimiter-less) display-math environments: `\begin{<mathenv>}…\end{…}`
// written without `$$`/`\[` fences (common in raw model output). Captured at the
// block level as a whole unit — including any immediately preceding `lhs =`
// line — so marked never splits it on inline `\\` row breaks. Restricted to math
// environments (isBareMathEnvironment), and the `≤3 leading spaces` + "block
// starts at offset 0" guards keep fenced/indented `\begin{cases}` code blocks
// for marked's own code rules.
const BARE_ENV_BEGIN = /(?:^|\n)[ \t]{0,3}\\begin\{([A-Za-z]+\*?)\}/;
function bareMathEnvBlock(src: string): readonly [number, number] | null {
	const bm = BARE_ENV_BEGIN.exec(src);
	if (!bm || !isBareMathEnvironment(bm[1])) return null;
	const beginLineStart = bm.index === 0 ? 0 : bm.index + 1; // skip the matched leading `\n`
	const endToken = `\\end{${bm[1]}}`;
	const endAt = src.indexOf(endToken, bm.index);
	if (endAt === -1) return null;
	// The `\end` must close before any blank line (i.e. within the same block).
	if (/\n[ \t]*\n/.test(src.slice(beginLineStart, endAt))) return null;
	let blockEnd = endAt + endToken.length;
	while (src.charCodeAt(blockEnd) === 0x20 || src.charCodeAt(blockEnd) === 0x09) blockEnd++;
	if (src.charCodeAt(blockEnd) === 0x0a) blockEnd++;
	// Pull in one immediately-preceding `lhs =`/open-delimiter line (e.g. `f(x) =`).
	let start = beginLineStart;
	if (start > 0 && src.charCodeAt(start - 1) === 0x0a) {
		const prevStart = src.lastIndexOf("\n", start - 2) + 1;
		const prevLine = src.slice(prevStart, start - 1);
		if (/[=([{]\s*$/.test(prevLine)) start = prevStart;
	}
	return [start, blockEnd];
}
const mathEnvBlockExtension: TokenizerAndRendererExtension = {
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

// Module-level LRU render cache
// Each session-tree navigation discards and recreates Markdown component
// instances, so the per-instance #cachedLines field is always cold on first
// render of a fresh component. This module-level cache survives across
// component lifetimes and eliminates redundant marked.lexer + highlightCode
// (Rust FFI) work for content/layout combinations already seen this session.

const RENDER_CACHE_MAX = 256; // sane cap: ~256 distinct message × width combos
const RENDER_CACHE_MAX_SIZE = 512 * 1024;
const RENDER_CACHE_MAX_ENTRY_SIZE = 32 * 1024;
const EMPTY_RENDER_LINES: readonly string[] = [];
const renderCache = new LRUCache<string, readonly string[]>({
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

// A reference-link definition (`[label]: dest`) resolves across the whole
// document, so a split lex cannot reproduce it — disable the streaming fast path
// when one is present (rare in streamed output). The label may contain
// backslash-escaped characters (`[a\]b]: x`), so escapes are matched explicitly;
// over-matching is safe (it only costs the fast path), under-matching is not.
const HAS_REF_DEF = /^ {0,3}\[(?:\\.|[^\]\\])+\]:/m;

// Can this text be lexed as an appended tail? A reference definition resolves
// across the whole document and CR is normalized by marked, so either one in the
// scanned span forces a full lex.
function canStreamLex(text: string): boolean {
	return !HAS_REF_DEF.test(text) && !text.includes("\r");
}

// Untrusted model output can over-nest markdown structure: a blockquote nests
// once per leading `>` (`>>>>…`), a list once per indentation step. marked's
// block lexer recurses per nesting level and is super-linear on list indent, so
// a payload nested thousands deep overflows the stack (deep `>`) or hangs for
// minutes (deep list) *before* render() — a trivial DoS on the TUI. Cap each
// line's structural nesting to a depth far beyond any real document; the
// render-depth guard (Markdown.MAX_RENDER_DEPTH) then bounds token recursion for
// whatever survives. Applied once per render, folded into tab normalization.
const MAX_BLOCKQUOTE_MARKERS = 24;
const MAX_LEADING_INDENT = 64;
// Cheap detector: does any line's leading `>`-run or whitespace-run exceed a cap?
// `.test()` short-circuits and allocates nothing on the common no-match input, so
// the streaming hotpath pays only a linear scan (as HAS_REF_DEF already does).
const OVER_NESTED = new RegExp(
	`(?:^|\\n)(?:[ \\t]*>){${MAX_BLOCKQUOTE_MARKERS + 1},}|(?:^|\\n)[ \\t]{${MAX_LEADING_INDENT + 1},}\\S`,
);
// Slow-path caps (only run when OVER_NESTED matches): keep the first N leading
// blockquote markers and drop the rest of the `>`-run; keep the first M leading
// whitespace chars and drop the rest up to the first non-space. Multiline `^`, so
// each line is capped independently — the transform stays line-local and thus
// append-stable for the streaming prefix cache.
const BLOCKQUOTE_CAP = new RegExp(`^((?:[ \\t]*>){${MAX_BLOCKQUOTE_MARKERS}})(?:[ \\t]*>)+`, "gm");
const INDENT_CAP = new RegExp(`^([ \\t]{${MAX_LEADING_INDENT}})[ \\t]+(?=\\S)`, "gm");

// Bound structural nesting depth so pathological input can neither overflow the
// lexer stack nor hang it. No-op (returns the input) unless a line actually
// over-nests, so realistic markdown pays only the OVER_NESTED scan.
function capMarkdownNesting(text: string): string {
	if (!OVER_NESTED.test(text)) return text;
	return text.replace(BLOCKQUOTE_CAP, "$1").replace(INDENT_CAP, "$1");
}

export function clearRenderCache(): void {
	renderCache.clear();
}

// Stable numeric IDs for structural theme/style objects (no ID field on type).
// WeakMap-keyed so the ID matches strict object identity and doesn't get copied by spread/cloning.
const themeObjectIds = new WeakMap<object, number>();
let nextObjectId = 0;
function objectId(o: object): number {
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

interface InlineStyleContext {
	applyText: (text: string) => string;
	stylePrefix: string;
}

type ListToken = Token & { items: Array<{ tokens?: Token[] }>; ordered: boolean; start?: number };
type TableCellToken = { tokens?: Token[] };
type TableAlign = "left" | "center" | "right" | null;
type TableToken = Token & {
	header: TableCellToken[];
	rows: TableCellToken[][];
	align?: TableAlign[];
	raw?: string;
};

function alignCellText(text: string, width: number, align: TableAlign): string {
	const slack = Math.max(0, width - visibleWidth(text));
	if (slack === 0) return text;
	if (align === "right") return padding(slack) + text;
	if (align === "center") {
		const left = Math.floor(slack / 2);
		return padding(left) + text + padding(slack - left);
	}
	return text + padding(slack);
}

function formatHyperlink(text: string, target: string): string {
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

function encodeTextSizedHeading(text: string, scale: 1 | 2 | 3): string {
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

const MATH_NEWLINES = /\n+/g;

function isMathToken(token: Token): token is Token & { text: string; display: boolean } {
	return (token as { type: string }).type === "math";
}

function renderMathToken(text: string): string {
	return latexToUnicode(text).replace(MATH_NEWLINES, " ");
}

function soleDisplayMath(tokens?: Token[]): (Token & { text: string }) | null {
	if (!tokens) return null;
	let math: (Token & { text: string; display: boolean }) | null = null;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (isMathToken(token) && token.display) {
			if (math) return null;
			math = token;
		} else if (!(token.type === "text" && typeof token.text === "string" && token.text.trim() === "")) {
			return null;
		}
	}
	return math;
}

function plainInlineTokens(tokens: Token[]): string {
	let result = "";
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (isMathToken(token)) {
			result += renderMathToken(token.text);
			continue;
		}
		switch (token.type) {
			case "text":
				result += token.tokens && token.tokens.length > 0 ? plainInlineTokens(token.tokens) : token.text;
				break;
			case "strong":
			case "em":
			case "del":
			case "link":
				result += plainInlineTokens(token.tokens || []);
				break;
			case "codespan":
				result += token.text;
				break;
			default:
				if ("text" in token && typeof token.text === "string") result += token.text;
				break;
		}
	}
	return result;
}

function inlineHtmlTag(token: Token): { name: string; closing: boolean } | null {
	if ((token as { type: string }).type !== "html") return null;
	const raw = (token as { raw?: unknown }).raw;
	if (typeof raw !== "string") return null;
	const name = htmlTagName(raw);
	if (!name) return null;
	return { name, closing: /^<\s*\//.test(raw) };
}

function collapseInlineHtml(tokens: Token[]): Token[] {
	let hasCode = false;
	for (let i = 0; i < tokens.length; i++) {
		if (inlineHtmlTag(tokens[i]!)?.name === "code") {
			hasCode = true;
			break;
		}
	}
	if (!hasCode) return tokens;

	const out: Token[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const tag = inlineHtmlTag(tokens[i]);
		if (tag?.name === "code") {
			if (tag.closing) continue; // stray `</code>` — drop it
			let j = i + 1;
			for (; j < tokens.length; j++) {
				const close = inlineHtmlTag(tokens[j]);
				if (close?.name === "code" && close.closing) break;
			}
			if (j >= tokens.length) continue; // unmatched `<code>` — drop it, render the rest normally
			const text = normalizeHtmlEntitiesForTerminal(plainInlineTokens(tokens.slice(i + 1, j)));
			out.push({ type: "codespan", raw: text, text } as Token);
			i = j;
			continue;
		}
		out.push(tokens[i]);
	}
	return out;
}

// Inline hex-color swatches
// When prose/thinking mentions a CSS hex color (e.g. #C5FFD6 or `#C5FFD6`),
// render a small chip painted with that color just before the code. The chip
// glyph comes from the theme's symbol set (ASCII → Unicode → Nerd Font), so it
// degrades gracefully; the color itself is exact 24-bit on truecolor terminals
// and the nearest 256-color cell otherwise (Bun.color quantizes for us).

const DEFAULT_COLOR_SWATCH_GLYPH = "■";

// `#` + 3-8 hex digits, not glued to a surrounding word/`#`/`&` (avoids HTML
// entities like &#9731; and paths like foo#fff) and not trailed by more hex
// (so over-long runs never produce a misleading swatch). Length/letter rules
// are enforced in classifyHexColor since the alternation can't express "exactly
// 3, 6, or 8".
const HEX_COLOR_REGEX = /(?<![\w#&])#([0-9a-fA-F]{3,8})(?![0-9a-fA-F])/g;
const HEX_COLOR_EXACT_REGEX = /^#([0-9a-fA-F]{3,8})$/;

function classifyHexColor(hex: string, strict: boolean): boolean {
	const n = hex.length;
	if (n !== 3 && n !== 6 && n !== 8) return false;
	if (strict && n === 3 && !/[a-fA-F]/.test(hex)) return false;
	return true;
}

function colorSwatch(hex: string, glyph: string): string {
	const ansi = Bun.color(`#${hex}`, TERMINAL.trueColor ? "ansi-16m" : "ansi-256");
	// Reset only the foreground (\x1b[39m) so an enclosing background/decoration
	// applied later by the line renderer survives across the swatch.
	return ansi ? `${ansi}${glyph}\x1b[39m ` : "";
}

function renderTextWithSwatches(text: string, applySegment: (t: string) => string, glyph: string): string {
	HEX_COLOR_REGEX.lastIndex = 0;
	let result = "";
	let last = 0;
	for (;;) {
		const match = HEX_COLOR_REGEX.exec(text);
		if (match === null) break;
		if (!classifyHexColor(match[1], true)) continue;
		const swatch = colorSwatch(match[1], glyph);
		if (!swatch) continue;
		if (match.index > last) result += applySegment(text.slice(last, match.index));
		result += swatch + applySegment(match[0]);
		last = match.index + match[0].length;
	}
	if (last === 0) return applySegment(text);
	if (last < text.length) result += applySegment(text.slice(last));
	return result;
}

function codespanSwatch(code: string, glyph: string): string {
	const match = HEX_COLOR_EXACT_REGEX.exec(code.trim());
	if (!match || !classifyHexColor(match[1], false)) return "";
	return colorSwatch(match[1], glyph);
}

interface RenderSignature {
	width: number;
	paddingX: number;
	paddingY: number;
	codeBlockIndent: number;
	themeId: number;
	defaultTextStyleId: number;
	imageProtocol: string;
	hyperlinks: boolean;
	textSizing: boolean;
	bgColorProbe: string;
	headingProbe: string;
}

interface StreamPrefixLineCache extends RenderSignature {
	text: string;
	tokenCount: number;
	lines: readonly string[];
}
interface StreamingDiffLineCache extends RenderSignature {
	lang: string | undefined;
	text: string;
	lines: readonly string[];
}

export class Markdown implements Component {
	#text: string;
	#paddingX: number; // Left/right padding
	#paddingY: number; // Top/bottom padding
	#defaultTextStyle?: DefaultTextStyle;
	#theme: MarkdownTheme;
	#defaultStylePrefix?: string;
	#codeBlockIndent: number;
	#renderDepth = 0;
	#inlineDepth = 0;

	// Cache for rendered output. Cached arrays are shared and returned by
	// reference (render contract: results are component-owned and immutable to
	// callers); the L2 LRU may hand the same array to multiple instances.
	#cachedText?: string;
	#cachedWidth?: number;
	#cachedLines?: readonly string[];
	#transientRenderCache = false;

	// Streaming-lex cache: the largest blank-line-bounded prefix of #text whose
	// block tokens are frozen, plus those tokens. marked has no resumable lexer,
	// but block tokenization is local across a "\n\n" boundary with balanced
	// fences, so lex(prefix) ++ lex(tail) === lex(prefix+tail). On append-only
	// growth (the streaming path) this re-lexes only the grown tail instead of the
	// whole buffer, turning O(N^2) reveal cost into O(N). Width/theme do not affect
	// tokenization, so this cache is independent of the render caches above.
	#streamPrefixText?: string;
	#streamPrefixTokens?: Token[];
	#streamPrefixLineCache?: StreamPrefixLineCache;
	// The text the frozen prefix above was cut from. Held by reference so a frame
	// re-deriving the same string knows the prefix still is one without comparing
	// the whole transcript again.
	#streamPrefixSource?: string;
	// Leading whole lines of #text that need no render normalization, so a frame
	// scans only what arrived after them (see #normalizeForRender).
	#normalizedCleanHead?: string;
	// Rows of the most recent render() that are settled — top padding plus the
	// rendered frozen token prefix — exposed via getLastRenderSettledRows()
	// for native-scrollback commit gating.
	#lastRenderSettledRows = 0;
	// Frozen-prefix text backing the last non-zero settled exposure. Settled
	// rows are declared final downstream, so a render whose frozen text no
	// longer extends this prefix (a rewind / wholesale rewrite) resets the
	// exposure to 0 and re-earns it — the exposure is hard-monotone within a
	// text lineage.
	#settledExposedText?: string;
	// True while #renderStreamingContentLines renders the frozen token range:
	// frozen code blocks highlight even in transient mode so their bytes match
	// the finalized render (they render once into the prefix line cache, so
	// the FFI cost is amortized). The volatile tail normally stays
	// unhighlighted; streaming diff fences line-highlight completed rows so
	// semantic colors reach native scrollback before rows leave the viewport.
	#renderingFrozenPrefix = false;
	#streamingDiffLineCache?: StreamingDiffLineCache;
	#activeRenderSignature?: RenderSignature;
	#cachedBgColorProbe = "";
	#cachedBgColorProbeId = -1;
	#cachedHeadingProbe = "";
	#cachedHeadingProbeId = -1;
	#cachedInlineStyleContext?: InlineStyleContext;
	#cachedInlineStyleContextId = -1;
	#cachedWalkContext?: InlineWalkContext;
	#cachedWalkContextId = -1;

	#ignoreTight = false;

	setIgnoreTight(ignore: boolean): this {
		this.#ignoreTight = ignore;
		this.invalidate();
		return this;
	}

	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
		codeBlockIndent: number = 2,
	) {
		this.#text = text;
		this.#paddingX = paddingX;
		this.#paddingY = paddingY;
		this.#theme = theme;
		this.#defaultTextStyle = defaultTextStyle;
		this.#codeBlockIndent = Math.max(0, Math.floor(codeBlockIndent));
	}

	setText(text: string): boolean {
		// Equality guard: streaming re-emits identical text on ticks that carried
		// no delta (throttled provider frames, reconciled tool-execution updates).
		// Without this, the caller-side `#cachedLines` gets thrown away and the
		// full lex + wrap runs per re-emit — one of the top CPU hotspots during
		// streaming (issue #4353). Mirrors `Text.setText`'s guard.
		if (text === this.#text) return false;
		this.#text = text;
		if (!text.trim()) {
			// Blank replacement: render() early-returns before #lexTokens can see
			// the non-append edit, so drop the frozen stream state here or it
			// outlives the content it indexed.
			this.#streamPrefixText = undefined;
			this.#streamPrefixTokens = undefined;
			this.#streamPrefixLineCache = undefined;
			this.#streamPrefixSource = undefined;
			this.#settledExposedText = undefined;
		}
		this.invalidate();
		return true;
	}

	invalidate(): void {
		this.#cachedText = undefined;
		this.#cachedWidth = undefined;
		this.#cachedLines = undefined;
	}
	get transientRenderCache(): boolean {
		return this.#transientRenderCache;
	}

	set transientRenderCache(value: boolean) {
		const next = value === true;
		if (this.#transientRenderCache === next) return;
		this.#transientRenderCache = next;
		this.invalidate();
	}

	getLastRenderSettledRows(): number {
		return this.#lastRenderSettledRows;
	}

	// Tab expansion and the nesting caps for render. Both are line-local — tabs
	// are replaced one character at a time and each cap is anchored at a line
	// start — so a span of whole lines that needed no transform cannot need one
	// because text arrived after it. Only the arrived tail is scanned, and text
	// that needs no transform is returned by reference rather than copied: the
	// nesting scan alone was 0.030ms of a 0.053ms frame at 10,000 streamed
	// tokens, spent on bytes that had already been scanned on every earlier
	// frame. A tail that does need transforming falls back to normalizing the
	// whole text, which is what every frame did before.
	#normalizeForRender(raw: string): string {
		const clean = this.#normalizedCleanHead;
		const from = clean !== undefined && raw.length >= clean.length && raw.startsWith(clean) ? clean.length : 0;
		const tail = from === 0 ? raw : raw.slice(from);
		if (tail.includes("\t") || OVER_NESTED.test(tail)) {
			this.#normalizedCleanHead = undefined;
			return capMarkdownNesting(replaceTabs(raw));
		}
		const boundary = raw.lastIndexOf("\n") + 1;
		if (boundary > from) this.#normalizedCleanHead = raw.slice(0, boundary);
		return raw;
	}

	// Lex `text` into block tokens, reusing the frozen stable prefix when the text
	// only grew (the streaming path). Falls back to a full lex whenever the prefix
	// is no longer a prefix (non-append edit), the text carries reference-link
	// definitions, or it contains CR (marked normalizes CRLF, which would desync
	// raw-span offsets). Every fallback is correctness-preserving — only speed
	// differs; the render loop sees the identical token list either way.
	//
	// On the streaming path the two refusals are read off the arrived tail alone.
	// A prefix is frozen only after the whole text passed this check, so neither
	// shape can be inside it, and re-reading the transcript for them was the
	// largest cost a long stream paid per frame: 0.032ms of a 0.082ms frame at
	// 10,000 streamed tokens, spent again on every token.
	#lexTokens(text: string): Token[] {
		const prefix = this.#streamPrefixText;
		const prefixTokens = this.#streamPrefixTokens;
		if (
			prefix !== undefined &&
			prefixTokens !== undefined &&
			text.length > prefix.length &&
			text.startsWith(prefix)
		) {
			const tail = text.slice(prefix.length);
			if (canStreamLex(tail)) {
				const tailTokens = markdownParser.lexer(tail);
				const tokens = prefixTokens.concat(tailTokens);
				this.#freezeStablePrefix(text, tokens, { preserveExisting: true });
				// `text` extends the prefix, proven just above, and the freeze only
				// ever advances the boundary within it. Recording which string that
				// was is what lets the render path skip proving it again.
				this.#streamPrefixSource = text;
				return tokens;
			}
		}
		const tokens = markdownParser.lexer(text);
		if (canStreamLex(text)) {
			this.#freezeStablePrefix(text, tokens, { preserveExisting: false });
			if (this.#streamPrefixText !== undefined) this.#streamPrefixSource = text;
		} else {
			this.#streamPrefixText = undefined;
			this.#streamPrefixTokens = undefined;
			this.#streamPrefixLineCache = undefined;
			this.#streamPrefixSource = undefined;
		}
		return tokens;
	}

	// Freeze the largest run of leading blocks that end on a hard "\n\n" boundary
	// (complete and immutable under append-only growth) so the next streaming
	// render re-lexes only the unfrozen tail. Caller guarantees no CR / no
	// reference definitions, so each token's `raw` is a verbatim slice of `text`
	// and the summed offsets address `text` exactly.
	//
	// A boundary already frozen stays frozen under append-only growth, so the
	// scan resumes there instead of re-summing every token's raw and re-slicing
	// the whole frozen prefix on every frame.
	#freezeStablePrefix(text: string, tokens: Token[], opts: { preserveExisting: boolean }): void {
		const existingText = opts.preserveExisting ? this.#streamPrefixText : undefined;
		const existingTokens = existingText === undefined ? undefined : this.#streamPrefixTokens;
		let pos = existingText === undefined ? 0 : existingText.length;
		let frozenEnd = pos;
		let frozenCount = existingTokens?.length ?? 0;
		for (let i = frozenCount; i < tokens.length; i++) {
			const raw = tokens[i].raw;
			const end = pos + raw.length;
			// A `space` token ending in "\n\n" closes the preceding block, but a
			// `list` before it can still be extended by a following same-marker
			// item across the blank line (CommonMark loose-list continuation),
			// which marked merges into one renumbered loose list. Freezing across
			// such a cut would keep the lists separate. Never freeze right after a
			// list — it stays in the re-lexed tail.
			if (raw.endsWith("\n\n") && tokens[i - 1]?.type !== "list") {
				frozenEnd = end;
				frozenCount = i + 1;
			}
			pos = end;
		}
		// Freeze only when the tail begins with real block content. If the next
		// char is whitespace (an extra blank line, or an indented continuation),
		// the block separator straddles the cut and lex(prefix)++lex(tail) would
		// desync from a full lex — e.g. a fence followed by "\n\n\n- list". When
		// frozenEnd is at end-of-text the next char is unknown, so defer.
		if (frozenCount > 0 && frozenEnd < text.length) {
			const next = text.charCodeAt(frozenEnd);
			if (next !== 0x20 /* space */ && next !== 0x0a /* \n */) {
				if (existingText === undefined || frozenEnd > existingText.length) {
					this.#streamPrefixText = text.slice(0, frozenEnd);
					this.#streamPrefixTokens = tokens.slice(0, frozenCount);
				}
				return;
			}
		}

		if (!opts.preserveExisting) {
			this.#streamPrefixText = undefined;
			this.#streamPrefixTokens = undefined;
			this.#streamPrefixLineCache = undefined;
			this.#streamPrefixSource = undefined;
		}
	}

	render(width: number): readonly string[] {
		// L1: per-instance cache — fastest path for repeated renders of the same
		// instance at the same width (e.g. resize debounce, repeated redraws).
		// Returning the cached reference is load-bearing: parents memoize their
		// concatenation on reference equality.
		if (this.#cachedLines && this.#cachedText === this.#text && this.#cachedWidth === width) {
			return this.#cachedLines;
		}

		// Recomputed below by the streaming path; every other path (cache-served,
		// empty text, non-streaming full render) exposes no settled rows.
		this.#lastRenderSettledRows = 0;

		const paddingX = this.#ignoreTight ? this.#paddingX : getPaddingX(this.#paddingX);
		const contentWidth = Math.max(1, width - paddingX * 2);

		if (!this.#text || this.#text.trim() === "") {
			this.#cachedText = this.#text;
			this.#cachedWidth = width;
			this.#cachedLines = EMPTY_RENDER_LINES;
			return EMPTY_RENDER_LINES;
		}

		// Replace tabs with 3 spaces for consistent rendering, then bound structural
		// nesting depth so pathological model output can't overflow or hang the lexer.
		const normalizedText = this.#normalizeForRender(this.#text);
		const signature = this.#renderSignature(width, paddingX);

		// L2: module-level LRU — survives component disposal/recreation across
		// session-tree navigations. Key encodes every dimension that affects the
		// render output so different configurations never collide.
		// Encode terminal capability state and theme/style function output samples
		// so that capability shifts (image protocol changes, hyperlink toggle) or
		// caller-supplied theme/bgColor functions that mutate their output without
		// changing object identity invalidate the cache entry.
		// bgColor probe uses \x01 (single non-printable byte): chalk/ANSI wrappers
		// pass arbitrary bytes through verbatim, so this is safe and minimizes the
		// risk of clashing with a function that returns text verbatim.
		// theme.heading is used as the representative theme probe — it's required
		// by MarkdownTheme and is one of the most styling-sensitive entries.
		let cacheKey: string | undefined;
		if (!this.transientRenderCache) {
			cacheKey = this.#renderCacheKey(normalizedText, signature);
			const cached = renderCache.get(cacheKey);
			if (cached !== undefined) {
				this.#cachedText = this.#text;
				this.#cachedWidth = width;
				this.#cachedLines = cached;
				return cached;
			}
		}

		const tokens = this.#lexTokens(normalizedText);
		let contentLines: string[];
		this.#activeRenderSignature = signature;
		try {
			contentLines = this.transientRenderCache
				? this.#renderStreamingContentLines(tokens, normalizedText, signature, contentWidth)
				: this.#renderContentLines(tokens, 0, tokens.length, contentWidth, signature);
		} finally {
			this.#activeRenderSignature = undefined;
		}
		const emptyLines = this.#renderEmptyPaddingLines(signature);

		const rawResult = emptyLines.length === 0 ? contentLines : emptyLines.concat(contentLines, emptyLines);
		const result = rawResult.length > 0 ? rawResult : [""];

		this.#cachedText = this.#text;
		this.#cachedWidth = width;
		this.#cachedLines = result;

		if (cacheKey !== undefined) {
			renderCache.set(cacheKey, result);
		}

		return result;
	}

	#renderSignature(width: number, paddingX: number): RenderSignature {
		const bgStyleId = this.#defaultTextStyle ? objectId(this.#defaultTextStyle) : -1;
		if (bgStyleId !== this.#cachedBgColorProbeId) {
			this.#cachedBgColorProbe = this.#defaultTextStyle?.bgColor ? this.#defaultTextStyle.bgColor("\x01") : "";
			this.#cachedBgColorProbeId = bgStyleId;
		}
		const themeId = objectId(this.#theme);
		if (themeId !== this.#cachedHeadingProbeId) {
			this.#cachedHeadingProbe = this.#theme.heading("");
			this.#cachedHeadingProbeId = themeId;
		}
		return {
			width,
			paddingX,
			paddingY: this.#paddingY,
			codeBlockIndent: this.#codeBlockIndent,
			themeId,
			defaultTextStyleId: bgStyleId,
			imageProtocol: TERMINAL.imageProtocol ?? "",
			hyperlinks: TERMINAL.hyperlinks,
			textSizing: TERMINAL.textSizing,
			bgColorProbe: this.#cachedBgColorProbe,
			headingProbe: this.#cachedHeadingProbe,
		};
	}

	#renderCacheKey(normalizedText: string, signature: RenderSignature): string {
		return `${normalizedText}\x00${signature.width}\x00${signature.paddingX}\x00${signature.paddingY}\x00${signature.codeBlockIndent}\x00${signature.themeId}\x00${signature.defaultTextStyleId}\x00${signature.imageProtocol}\x00${signature.hyperlinks ? 1 : 0}\x00${signature.textSizing ? 1 : 0}\x00${signature.bgColorProbe}\x00${signature.headingProbe}`;
	}

	#renderStreamingContentLines(
		tokens: Token[],
		normalizedText: string,
		signature: RenderSignature,
		contentWidth: number,
	): string[] {
		const frozenText = this.#streamPrefixText;
		const frozenTokenCount = this.#streamPrefixTokens?.length ?? 0;
		// #lexTokens records the string it left this prefix in place for, and it
		// runs on every uncached render, so identity answers whether the prefix is
		// still a prefix. Comparing the two strings instead re-read the whole
		// settled transcript on every frame to reach the same answer. Anything
		// else renders in full, which is correct and only slower.
		if (frozenText === undefined || frozenTokenCount === 0 || this.#streamPrefixSource !== normalizedText) {
			return this.#renderContentLines(tokens, 0, tokens.length, contentWidth, signature);
		}

		// The frozen rows are held as one immutable array and reused by reference
		// while nothing new freezes, so a frame copies them exactly once — into
		// the array it returns. Spreading them into an accumulator and slicing
		// that accumulator back into the cache copied every settled row twice per
		// frame, and `push(...rows)` puts one argument on the stack per row,
		// which a long transcript is eventually large enough to overflow.
		const reusablePrefix = this.#matchingStreamPrefixLineCache(normalizedText, frozenText, signature);
		let frozenLines: readonly string[];
		if (reusablePrefix && reusablePrefix.tokenCount === frozenTokenCount) {
			frozenLines = reusablePrefix.lines;
		} else {
			const reusedUntil =
				reusablePrefix && reusablePrefix.tokenCount < frozenTokenCount ? reusablePrefix.tokenCount : 0;
			// Frozen tokens render with full fidelity (syntax highlighting on)
			// so these cached rows byte-match the finalized render.
			this.#renderingFrozenPrefix = true;
			let rendered: string[];
			try {
				rendered = this.#renderContentLines(tokens, reusedUntil, frozenTokenCount, contentWidth, signature);
			} finally {
				this.#renderingFrozenPrefix = false;
			}
			frozenLines = reusedUntil > 0 && reusablePrefix ? reusablePrefix.lines.concat(rendered) : rendered;
			this.#streamPrefixLineCache = {
				...signature,
				text: frozenText,
				tokenCount: frozenTokenCount,
				lines: frozenLines,
			};
		}

		// Settled exposure (hard-monotone): these rows are declared final to
		// the host, so expose them only while the frozen text still extends
		// the previously exposed prefix; a rewind resets to 0 and re-earns on
		// the rewritten lineage.
		if (frozenLines.length > 0) {
			const exposed = this.#settledExposedText;
			if (exposed === undefined || exposed === frozenText || frozenText.startsWith(exposed)) {
				this.#settledExposedText = frozenText;
				this.#lastRenderSettledRows = signature.paddingY + frozenLines.length;
			} else {
				this.#settledExposedText = undefined;
			}
		}

		if (frozenTokenCount < tokens.length) {
			const tail = this.#renderContentLines(tokens, frozenTokenCount, tokens.length, contentWidth, signature);
			return frozenLines.concat(tail);
		}
		return frozenLines.slice();
	}

	// `frozenText` is already known to be a prefix of `normalizedText`. When the
	// entry was written for that same string — the common case, since the frozen
	// text is reused by reference while nothing new freezes — both prefix
	// questions are already answered and comparing the transcript again answers
	// nothing.
	#matchingStreamPrefixLineCache(
		normalizedText: string,
		frozenText: string,
		signature: RenderSignature,
	): StreamPrefixLineCache | undefined {
		const cache = this.#streamPrefixLineCache;
		if (!cache) return undefined;
		if (cache.text !== frozenText && (!normalizedText.startsWith(cache.text) || !frozenText.startsWith(cache.text))) {
			return undefined;
		}
		if (cache.width !== signature.width) return undefined;
		if (cache.paddingX !== signature.paddingX) return undefined;
		if (cache.paddingY !== signature.paddingY) return undefined;
		if (cache.codeBlockIndent !== signature.codeBlockIndent) return undefined;
		if (cache.themeId !== signature.themeId) return undefined;
		if (cache.defaultTextStyleId !== signature.defaultTextStyleId) return undefined;
		if (cache.imageProtocol !== signature.imageProtocol) return undefined;
		if (cache.hyperlinks !== signature.hyperlinks) return undefined;
		if (cache.textSizing !== signature.textSizing) return undefined;
		if (cache.bgColorProbe !== signature.bgColorProbe) return undefined;
		if (cache.headingProbe !== signature.headingProbe) return undefined;
		return cache;
	}

	#renderContentLines(
		tokens: Token[],
		start: number,
		end: number,
		contentWidth: number,
		signature: RenderSignature,
	): string[] {
		const renderedLines: string[] = [];
		for (let i = start; i < end; i++) {
			const token = tokens[i];
			const nextToken = tokens[i + 1];
			const tokenLines = this.#renderToken(token, contentWidth, nextToken?.type);
			for (let j = 0; j < tokenLines.length; j++) renderedLines.push(tokenLines[j]);
		}

		const leftMargin = padding(signature.paddingX);
		const rightMargin = padding(signature.paddingX);
		const bgFn = this.#defaultTextStyle?.bgColor;
		const contentLines: string[] = [];
		let previousLineWasOsc66 = false;

		for (let li = 0; li < renderedLines.length; li++) {
			const line = renderedLines[li]!;
			// Skip wrapping for image protocol lines and OSC 66 sized headings
			// (would corrupt escape sequences / split the indivisible sized span).
			const isOsc66 = isOsc66Line(line);
			const isImageOrOsc66 = TERMINAL.isImageLine(line) || isOsc66;
			const wrapped = isImageOrOsc66 ? undefined : wrapTextWithAnsi(line, contentWidth);
			const lines = isImageOrOsc66 ? 1 : wrapped!.length;
			for (let wi = 0; wi < lines; wi++) {
				const wLine = isImageOrOsc66 ? line : wrapped![wi]!;
				// The first empty row after a scale>1 OSC 66 heading is structural:
				// it reserves the lower cells occupied by the multicell glyphs. Do
				// not pad or background-fill it, because real spaces on that row can
				// interact with Kitty's multicell overwrite rules during the first
				// paint. Leave it as a cursor-only newline.
				if (previousLineWasOsc66 && wLine === "") {
					contentLines.push("");
					previousLineWasOsc66 = false;
					continue;
				}

				if (isImageOrOsc66) {
					contentLines.push(wLine);
					previousLineWasOsc66 = isOsc66;
					continue;
				}

				previousLineWasOsc66 = false;

				if (bgFn) {
					contentLines.push(applyBackgroundToLine(leftMargin + wLine + rightMargin, signature.width, bgFn));
				} else {
					// No background - just pad to width. Measure the line alone and
					// subtract the margin widths already known, avoiding a
					// visibleWidth() call on the full concatenated string.
					const paddingNeeded = Math.max(0, signature.width - visibleWidth(wLine) - 2 * signature.paddingX);
					contentLines.push(leftMargin + wLine + rightMargin + padding(paddingNeeded));
				}
			}
		}

		return contentLines;
	}

	#codeFenceRow(lang: string | undefined, pos: "open" | "close"): string {
		if (this.#theme.codeBlockFence) return this.#theme.codeBlockFence(lang || undefined, pos);
		return this.#theme.codeBlockBorder(pos === "open" ? `\`\`\`${lang || ""}` : "```");
	}

	#renderCodeBodyLines(token: Token, codeIndent: string): string[] {
		const bodyLines: string[] = [];
		const tokenText = "text" in token && typeof token.text === "string" ? token.text : "";
		const lang = "lang" in token && typeof token.lang === "string" ? token.lang : undefined;
		const normalizedLang = lang?.toLowerCase();
		const canStreamDiff =
			this.transientRenderCache &&
			!this.#renderingFrozenPrefix &&
			this.#theme.highlightCode &&
			(normalizedLang === "diff" || normalizedLang === "patch" || normalizedLang === "udiff");

		if (this.#theme.highlightCode && (!this.transientRenderCache || this.#renderingFrozenPrefix)) {
			const highlightedLines = this.#theme.highlightCode(tokenText, lang);
			for (let hi = 0; hi < highlightedLines.length; hi++) {
				bodyLines.push(`${codeIndent}${highlightedLines[hi]!}`);
			}
			return bodyLines;
		}

		if (canStreamDiff) {
			const closedFence = this.#codeTokenHasClosingFence(token);
			const lineEnd = tokenText.lastIndexOf("\n");
			if (closedFence || lineEnd >= 0) {
				const completedText = closedFence ? tokenText : tokenText.slice(0, lineEnd);
				const diffLines = this.#highlightStreamingDiffLines(completedText, lang);
				for (let di = 0; di < diffLines.length; di++) {
					bodyLines.push(`${codeIndent}${diffLines[di]!}`);
				}
				if (!closedFence) {
					const remainingLines = tokenText.slice(lineEnd + 1).split("\n");
					for (let ri = 0; ri < remainingLines.length; ri++) {
						bodyLines.push(`${codeIndent}${this.#theme.codeBlock(remainingLines[ri]!)}`);
					}
				}
				return bodyLines;
			}
		}

		const fallbackLines = tokenText.split("\n");
		for (let fi = 0; fi < fallbackLines.length; fi++) {
			bodyLines.push(`${codeIndent}${this.#theme.codeBlock(fallbackLines[fi]!)}`);
		}
		return bodyLines;
	}

	#codeTokenHasClosingFence(token: Token): boolean {
		const raw = "raw" in token && typeof token.raw === "string" ? token.raw : "";
		const firstLineEnd = raw.indexOf("\n");
		if (firstLineEnd < 0) return false;
		const openingLine = raw.slice(0, firstLineEnd);
		const openingTrimmed = openingLine.trimStart();
		const openingIndent = openingLine.length - openingTrimmed.length;
		if (openingIndent > 3) return false;
		const fenceChar = openingTrimmed.charAt(0);
		if (fenceChar !== "`" && fenceChar !== "~") return false;
		let fenceLength = 0;
		while (openingTrimmed.charAt(fenceLength) === fenceChar) fenceLength++;
		if (fenceLength < 3) return false;

		let lineStart = firstLineEnd + 1;
		while (lineStart <= raw.length) {
			const lineEnd = raw.indexOf("\n", lineStart);
			const line = lineEnd >= 0 ? raw.slice(lineStart, lineEnd) : raw.slice(lineStart);
			const trimmed = line.trimStart();
			const indent = line.length - trimmed.length;
			let closingLength = 0;
			while (trimmed.charAt(closingLength) === fenceChar) closingLength++;
			if (indent <= 3 && closingLength >= fenceLength && trimmed.slice(closingLength).trim().length === 0) {
				return true;
			}
			if (lineEnd < 0) break;
			lineStart = lineEnd + 1;
		}
		return false;
	}

	#highlightStreamingDiffLines(completedText: string, lang: string | undefined): readonly string[] {
		const highlightCode = this.#theme.highlightCode;
		if (!highlightCode) return [];
		const signature = this.#activeRenderSignature;
		const cache = this.#streamingDiffLineCache;
		if (
			signature &&
			cache &&
			completedText.startsWith(cache.text) &&
			(cache.text.length === completedText.length || completedText.charCodeAt(cache.text.length) === 0x0a) &&
			cache.lang === lang &&
			cache.width === signature.width &&
			cache.paddingX === signature.paddingX &&
			cache.paddingY === signature.paddingY &&
			cache.codeBlockIndent === signature.codeBlockIndent &&
			cache.themeId === signature.themeId &&
			cache.defaultTextStyleId === signature.defaultTextStyleId &&
			cache.imageProtocol === signature.imageProtocol &&
			cache.hyperlinks === signature.hyperlinks &&
			cache.textSizing === signature.textSizing &&
			cache.bgColorProbe === signature.bgColorProbe &&
			cache.headingProbe === signature.headingProbe
		) {
			if (completedText.length === cache.text.length) return cache.lines;
			const lines = cache.lines.slice();
			const addedText = completedText.slice(cache.text.length + 1);
			const addedLines = addedText.split("\n");
			for (let ai = 0; ai < addedLines.length; ai++) {
				const hl = highlightCode(addedLines[ai]!, lang);
				for (let j = 0; j < hl.length; j++) lines.push(hl[j]);
			}
			this.#streamingDiffLineCache = { ...signature, lang, text: completedText, lines };
			return lines;
		}

		const lines: string[] = [];
		const fullLines = completedText.split("\n");
		for (let fi = 0; fi < fullLines.length; fi++) {
			const hl = highlightCode(fullLines[fi]!, lang);
			for (let j = 0; j < hl.length; j++) lines.push(hl[j]);
		}
		if (signature) {
			this.#streamingDiffLineCache = { ...signature, lang, text: completedText, lines };
		}
		return lines;
	}

	#renderEmptyPaddingLines(signature: RenderSignature): string[] {
		const emptyLine = padding(signature.width);
		const bgFn = this.#defaultTextStyle?.bgColor;
		const line = bgFn ? applyBackgroundToLine(emptyLine, signature.width, bgFn) : emptyLine;
		const emptyLines: string[] = [];
		for (let i = 0; i < signature.paddingY; i++) {
			emptyLines.push(line);
		}
		return emptyLines;
	}

	#applyDefaultStyle(text: string): string {
		if (!this.#defaultTextStyle) {
			return text;
		}

		let styled = text;

		if (this.#defaultTextStyle.color) {
			styled = this.#defaultTextStyle.color(styled);
		}

		if (this.#defaultTextStyle.bold) {
			styled = this.#theme.bold(styled);
		}
		if (this.#defaultTextStyle.italic) {
			styled = this.#theme.italic(styled);
		}
		if (this.#defaultTextStyle.strikethrough) {
			styled = this.#theme.strikethrough(styled);
		}
		if (this.#defaultTextStyle.underline) {
			styled = this.#theme.underline(styled);
		}

		return styled;
	}

	#getDefaultStylePrefix(): string {
		if (!this.#defaultTextStyle) {
			return "";
		}

		if (this.#defaultStylePrefix !== undefined) {
			return this.#defaultStylePrefix;
		}

		const sentinel = "\u0000";
		let styled = sentinel;

		if (this.#defaultTextStyle.color) {
			styled = this.#defaultTextStyle.color(styled);
		}

		if (this.#defaultTextStyle.bold) {
			styled = this.#theme.bold(styled);
		}
		if (this.#defaultTextStyle.italic) {
			styled = this.#theme.italic(styled);
		}
		if (this.#defaultTextStyle.strikethrough) {
			styled = this.#theme.strikethrough(styled);
		}
		if (this.#defaultTextStyle.underline) {
			styled = this.#theme.underline(styled);
		}

		const sentinelIndex = styled.indexOf(sentinel);
		this.#defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
		return this.#defaultStylePrefix;
	}

	#getStylePrefix(styleFn: (text: string) => string): string {
		const sentinel = "\u0000";
		const styled = styleFn(sentinel);
		const sentinelIndex = styled.indexOf(sentinel);
		return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
	}

	#getDefaultInlineStyleContext(): InlineStyleContext {
		const styleId = this.#defaultTextStyle ? objectId(this.#defaultTextStyle) : -1;
		if (styleId === this.#cachedInlineStyleContextId && this.#cachedInlineStyleContext) {
			return this.#cachedInlineStyleContext;
		}
		const ctx: InlineStyleContext = {
			applyText: (text: string) => this.#applyDefaultStyle(text),
			stylePrefix: this.#getDefaultStylePrefix(),
		};
		this.#cachedInlineStyleContext = ctx;
		this.#cachedInlineStyleContextId = styleId;
		return ctx;
	}

	static readonly MAX_RENDER_DEPTH = 20;

	static readonly MAX_INLINE_DEPTH = 32;

	#renderToken(token: Token, width: number, nextTokenType?: string, styleContext?: InlineStyleContext): string[] {
		if (this.#renderDepth >= Markdown.MAX_RENDER_DEPTH) {
			const raw = "raw" in token && typeof token.raw === "string" ? token.raw : "";
			if (!raw) return [];
			return [this.#applyDefaultStyle(raw.replace(/[\r\n]+/g, " "))];
		}
		this.#renderDepth++;
		try {
			return this.#renderTokenInner(token, width, nextTokenType, styleContext);
		} finally {
			this.#renderDepth--;
		}
	}

	#renderTokenInner(token: Token, width: number, nextTokenType?: string, styleContext?: InlineStyleContext): string[] {
		const lines: string[] = [];

		// Display math block (own-line `$$…$$` / `\[…\]`): stack `\frac` vertically
		// and keep `\\` row breaks, so fractions and matrices span multiple lines.
		if (isMathToken(token)) {
			const mathLines = latexToBlock(token.text);
			for (let mi = 0; mi < mathLines.length; mi++) lines.push(this.#applyDefaultStyle(mathLines[mi]!));
			if (nextTokenType && nextTokenType !== "space") lines.push("");
			return lines;
		}

		switch (token.type) {
			case "heading": {
				const headingLevel = token.depth;
				const headingText = this.#renderInlineTokens(token.tokens || [], styleContext);
				const headingPlainText = plainInlineTokens(token.tokens || []);
				let styledHeading: string;
				if (headingLevel === 1 && TERMINAL.textSizing) {
					const plainWidth = visibleWidth(headingPlainText);
					if (plainWidth > 0 && 2 * plainWidth <= width) {
						const sizedHeading = encodeTextSizedHeading(headingPlainText, 2);
						lines.push(this.#theme.heading(this.#theme.bold(this.#theme.underline(sizedHeading))));
						lines.push(""); // reserve the heading's second visual row
						if (nextTokenType && nextTokenType !== "space") {
							lines.push(""); // Add spacing after headings (unless space token follows)
						}
						break;
					}
				}
				if (headingLevel === 1) {
					styledHeading = this.#theme.heading(this.#theme.bold(this.#theme.underline(headingText)));
				} else if (headingLevel === 2) {
					styledHeading = this.#theme.heading(this.#theme.bold(headingText));
				} else {
					styledHeading = this.#theme.heading(
						this.#theme.bold(
							(HEADING_PREFIXES[headingLevel - 1] ?? `${"#".repeat(headingLevel)} `) + headingText,
						),
					);
				}
				lines.push(styledHeading);
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after headings (unless space token follows)
				}
				break;
			}

			case "paragraph": {
				const displayMath = soleDisplayMath(token.tokens);
				if (displayMath) {
					const paraMathLines = latexToBlock(displayMath.text);
					for (let mi = 0; mi < paraMathLines.length; mi++)
						lines.push(this.#applyDefaultStyle(paraMathLines[mi]!));
					if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") lines.push("");
					break;
				}
				const paragraphText = this.#renderInlineTokens(token.tokens || [], styleContext);
				const hangLines = hangWrapTreeGuideLines(paragraphText, width) ?? [paragraphText];
				for (let j = 0; j < hangLines.length; j++) lines.push(hangLines[j]);
				if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
					lines.push("");
				}
				break;
			}

			case "code": {
				// Mermaid diagrams render as ASCII art when the theme supplies a
				// resolver. The art is preformatted, so clip each row to the content
				// width: the later wrap pass would otherwise fragment the box-drawing
				// canvas. truncateToWidth is ANSI- and wide-char-aware, and the
				// resolver already re-fits over-wide horizontal graphs top-down.
				if (token.lang === "mermaid" && this.#theme.resolveMermaidAscii) {
					const ascii = this.#theme.resolveMermaidAscii(token.text, width);
					if (ascii) {
						const asciiLines = ascii.split("\n");
						for (let ai = 0; ai < asciiLines.length; ai++) {
							const asciiLine = asciiLines[ai]!;
							lines.push(
								visibleWidth(asciiLine) > width ? truncateToWidth(asciiLine, width, Ellipsis.Omit) : asciiLine,
							);
						}
						if (nextTokenType && nextTokenType !== "space") {
							lines.push("");
						}
						break;
					}
				}

				const codeIndent = padding(this.#codeBlockIndent);
				lines.push(this.#codeFenceRow(token.lang, "open"));
				const codeLines = this.#renderCodeBodyLines(token, codeIndent);
				for (let bi = 0; bi < codeLines.length; bi++) {
					lines.push(codeLines[bi]!);
				}
				lines.push(this.#codeFenceRow(token.lang, "close"));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after code blocks (unless space token follows)
				}
				break;
			}

			case "list": {
				const listLines = this.#renderList(token as ListToken, 0, styleContext);
				for (let j = 0; j < listLines.length; j++) lines.push(listLines[j]);
				break;
			}

			case "table": {
				const tableLines = this.#renderTable(token as TableToken, width, nextTokenType, styleContext);
				for (let j = 0; j < tableLines.length; j++) lines.push(tableLines[j]);
				break;
			}

			case "blockquote": {
				const quoteInlineStyleContext: InlineStyleContext = {
					applyText: (text: string) => text,
					stylePrefix: "",
				};
				const quoteContentWidth = Math.max(1, width - 2);
				const quoteTokens = token.tokens || [];
				const renderedQuoteLines: string[] = [];

				for (let i = 0; i < quoteTokens.length; i++) {
					const quoteToken = quoteTokens[i];
					const nextQuoteToken = quoteTokens[i + 1];
					const quoteLines = this.#renderToken(
						quoteToken,
						quoteContentWidth,
						nextQuoteToken?.type,
						quoteInlineStyleContext,
					);
					for (let j = 0; j < quoteLines.length; j++) renderedQuoteLines.push(quoteLines[j]);
				}

				while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1] === "") {
					renderedQuoteLines.pop();
				}

				const borderLines = this.#applyQuoteBorder(renderedQuoteLines, width);
				for (let j = 0; j < borderLines.length; j++) lines.push(borderLines[j]);
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after blockquotes (unless space token follows)
				}
				break;
			}

			case "hr": {
				const raw = "raw" in token && typeof token.raw === "string" ? token.raw.trim() : "";
				lines.push(this.#renderHrLine(width, raw[0] || ""));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after horizontal rules (unless space token follows)
				}
				break;
			}

			case "html":
				if ("raw" in token && typeof token.raw === "string") {
					const htmlLines = this.#renderHtmlBlock(token.raw, width);
					for (let j = 0; j < htmlLines.length; j++) lines.push(htmlLines[j]);
				}
				break;

			case "space":
				lines.push("");
				break;

			default:
				if ("text" in token && typeof token.text === "string") {
					lines.push(token.text);
				}
		}

		return lines;
	}

	#renderHrLine(width: number, sourceChar = ""): string {
		const fillChar = getHrChar(sourceChar, this.#theme.symbols.hrChar);
		return this.#theme.hr(fillChar.repeat(Math.min(width, 80)));
	}

	#applyQuoteBorder(renderedLines: string[], width: number): string[] {
		const quoteStyle = (text: string) => this.#theme.quote(this.#theme.italic(text));
		const quoteStylePrefix = this.#getStylePrefix(quoteStyle);
		const applyQuoteStyle = (line: string): string => {
			if (!quoteStylePrefix) {
				return quoteStyle(line);
			}
			const lineWithReappliedStyle = line.replaceAll(SGR_RESET, `${SGR_RESET}${quoteStylePrefix}`);
			return quoteStyle(lineWithReappliedStyle);
		};
		const quoteContentWidth = Math.max(1, width - 2);
		const lines: string[] = [];
		for (let qi = 0; qi < renderedLines.length; qi++) {
			const styledLine = applyQuoteStyle(renderedLines[qi]!);
			const wrapped = wrapTextWithAnsi(styledLine, quoteContentWidth);
			for (let wi = 0; wi < wrapped.length; wi++) {
				lines.push(this.#theme.quoteBorder(`${this.#theme.symbols.quoteBorder} `) + wrapped[wi]!);
			}
		}
		return lines;
	}

	#renderHtmlBlock(raw: string, width: number): string[] {
		const lines: string[] = [];
		const state = createHtmlNormalizationState();
		const codeHook = (text: string): string => this.#theme.code(text) + this.#getDefaultStylePrefix();
		const flushText = (chunk: string): void => {
			const cleaned = normalizeHtmlForTerminal(chunk, state, codeHook);
			if (cleaned.trim() === "") return;
			const termLines = splitTerminalLines(cleaned);
			for (let ti = 0; ti < termLines.length; ti++) {
				const trimmed = termLines[ti]!.trimEnd();
				lines.push(trimmed.trim() === "" ? "" : this.#applyDefaultStyle(trimmed));
			}
		};
		let lastIndex = 0;
		BLOCK_HTML_REGEX.lastIndex = 0;
		for (let match = BLOCK_HTML_REGEX.exec(raw); match !== null; match = BLOCK_HTML_REGEX.exec(raw)) {
			flushText(raw.slice(lastIndex, match.index));
			lastIndex = match.index + match[0].length;
			if (match[1] !== undefined) {
				const quoteLines = this.#renderHtmlBlockquote(match[1], width);
				for (let j = 0; j < quoteLines.length; j++) lines.push(quoteLines[j]);
			} else {
				lines.push(this.#renderHrLine(width));
			}
		}
		flushText(raw.slice(lastIndex));
		return lines;
	}

	#renderHtmlBlockquote(inner: string, width: number): string[] {
		const cleaned = normalizeHtmlForTerminal(inner, createHtmlNormalizationState(), text => this.#theme.code(text));
		const rawLines = splitTerminalLines(cleaned);
		const innerLines = new Array<string>(rawLines.length);
		for (let li = 0; li < rawLines.length; li++) innerLines[li] = rawLines[li]!.trimEnd();
		while (innerLines.length > 0 && innerLines[innerLines.length - 1] === "") innerLines.pop();
		return this.#applyQuoteBorder(innerLines, width);
	}

	#renderInlineTokens(tokens: Token[], styleContext?: InlineStyleContext): string {
		if (this.#inlineDepth >= Markdown.MAX_INLINE_DEPTH) {
			// Degrade a pathologically deep inline tree to styled plain text: one
			// O(n) flatten + one style pass, no further per-level ANSI wrapping.
			const ctx = styleContext ?? this.#getDefaultInlineStyleContext();
			const plain = plainInlineTokens(tokens);
			return plain === "" ? "" : ctx.applyText(plain);
		}
		this.#inlineDepth++;
		try {
			return this.#renderInlineTokensInner(tokens, styleContext);
		} finally {
			this.#inlineDepth--;
		}
	}

	#renderInlineTokensInner(tokens: Token[], styleContext?: InlineStyleContext): string {
		if (!styleContext) {
			const styleId = this.#defaultTextStyle ? objectId(this.#defaultTextStyle) : -1;
			if (styleId === this.#cachedWalkContextId && this.#cachedWalkContext) {
				return walkInlineTokens(tokens, this.#cachedWalkContext);
			}
			const resolved = this.#getDefaultInlineStyleContext();
			const { applyText, stylePrefix } = resolved;
			const swatchGlyph = this.#theme.symbols.colorSwatch || DEFAULT_COLOR_SWATCH_GLYPH;
			const applyTextWithNewlines = (text: string): string => {
				if (text.indexOf("\n") === -1) return text === "" ? "" : applyText(text);
				const segments = text.split("\n");
				let result = "";
				for (let si = 0; si < segments.length; si++) {
					if (si > 0) result += "\n";
					result += segments[si] === "" ? "" : applyText(segments[si]!);
				}
				return result;
			};
			const ctx: InlineWalkContext = {
				theme: this.#theme,
				applyText,
				applyTextWithNewlines,
				renderLeafText: (text: string) => renderTextWithSwatches(text, applyTextWithNewlines, swatchGlyph),
				stylePrefix,
				swatchGlyph,
				hyperlinks: true,
				useHtmlState: true,
				handleBlocks: true,
				stripTrailingPrefix: true,
				renderNested: (subTokens: Token[]) => this.#renderInlineTokens(subTokens, resolved),
			};
			this.#cachedWalkContext = ctx;
			this.#cachedWalkContextId = styleId;
			return walkInlineTokens(tokens, ctx);
		}
		const { applyText, stylePrefix } = styleContext;
		const applyTextWithNewlines = (text: string): string => {
			if (text.indexOf("\n") === -1) return text === "" ? "" : applyText(text);
			const segments = text.split("\n");
			let result = "";
			for (let si = 0; si < segments.length; si++) {
				if (si > 0) result += "\n";
				result += segments[si] === "" ? "" : applyText(segments[si]!);
			}
			return result;
		};
		const swatchGlyph = this.#theme.symbols.colorSwatch || DEFAULT_COLOR_SWATCH_GLYPH;
		return walkInlineTokens(tokens, {
			theme: this.#theme,
			applyText,
			applyTextWithNewlines,
			renderLeafText: (text: string) => renderTextWithSwatches(text, applyTextWithNewlines, swatchGlyph),
			stylePrefix,
			swatchGlyph,
			hyperlinks: true,
			useHtmlState: true,
			handleBlocks: true,
			stripTrailingPrefix: true,
			renderNested: (subTokens: Token[]) => this.#renderInlineTokens(subTokens, styleContext),
		});
	}

	#renderList(token: ListToken, depth: number, styleContext?: InlineStyleContext): string[] {
		const lines: string[] = [];
		const indent = padding(depth * 2);
		const startNumber = token.start ?? 1;

		for (let i = 0; i < token.items.length; i++) {
			const item = token.items[i];
			const bullet = token.ordered ? `${startNumber + i}. ` : "- ";
			// Continuation rows align under the item text, so the hang matches the
			// actual bullet width (`10. ` is 4 cells, not 2).
			const continuationIndent = indent + padding(bullet.length);

			// Process item tokens; nested-list lines arrive structurally tagged and
			// already carry their own full indent.
			const itemLines = this.#renderListItem(item.tokens || [], depth, styleContext);

			if (itemLines.length > 0) {
				const firstLine = itemLines[0]!;
				if (firstLine.nested) {
					lines.push(firstLine.text);
				} else {
					lines.push(indent + this.#theme.listBullet(bullet) + firstLine.text);
				}

				for (let j = 1; j < itemLines.length; j++) {
					const line = itemLines[j]!;
					if (line.nested) {
						lines.push(line.text);
					} else {
						lines.push(continuationIndent + line.text);
					}
				}
			} else {
				lines.push(indent + this.#theme.listBullet(bullet));
			}
		}

		return lines;
	}

	#renderListItem(
		tokens: Token[],
		parentDepth: number,
		styleContext?: InlineStyleContext,
	): Array<{ text: string; nested: boolean }> {
		const lines: Array<{ text: string; nested: boolean }> = [];

		for (let ti = 0; ti < tokens.length; ti++) {
			const token = tokens[ti]!;
			if (token.type === "list") {
				const nestedLines = this.#renderList(token as ListToken, parentDepth + 1, styleContext);
				for (let ni = 0; ni < nestedLines.length; ni++) {
					lines.push({ text: nestedLines[ni]!, nested: true });
				}
			} else if (token.type === "text") {
				const displayMath = soleDisplayMath(token.tokens);
				if (displayMath) {
					const apply = styleContext?.applyText ?? ((t: string) => this.#applyDefaultStyle(t));
					const textMathLines = latexToBlock(displayMath.text);
					for (let mi = 0; mi < textMathLines.length; mi++)
						lines.push({ text: apply(textMathLines[mi]!), nested: false });
				} else {
					const text =
						token.tokens && token.tokens.length > 0
							? this.#renderInlineTokens(token.tokens, styleContext)
							: token.text || "";
					lines.push({ text, nested: false });
				}
			} else if (token.type === "paragraph") {
				const apply = styleContext?.applyText ?? ((t: string) => this.#applyDefaultStyle(t));
				const displayMath = soleDisplayMath(token.tokens);
				if (displayMath) {
					const paraMathLines = latexToBlock(displayMath.text);
					for (let mi = 0; mi < paraMathLines.length; mi++)
						lines.push({ text: apply(paraMathLines[mi]!), nested: false });
				} else {
					lines.push({ text: this.#renderInlineTokens(token.tokens || [], styleContext), nested: false });
				}
			} else if (token.type === "code") {
				const codeIndent = padding(this.#codeBlockIndent);
				lines.push({ text: this.#codeFenceRow(token.lang, "open"), nested: false });
				const codeBodyLines = this.#renderCodeBodyLines(token, codeIndent);
				for (let bi = 0; bi < codeBodyLines.length; bi++) {
					lines.push({ text: codeBodyLines[bi]!, nested: false });
				}
				lines.push({ text: this.#codeFenceRow(token.lang, "close"), nested: false });
			} else if (isMathToken(token)) {
				// Display math block inside a list item: stack fractions / matrix rows.
				const apply = styleContext?.applyText ?? ((t: string) => this.#applyDefaultStyle(t));
				const isMathLines = latexToBlock(token.text);
				for (let mi = 0; mi < isMathLines.length; mi++)
					lines.push({ text: apply(isMathLines[mi]!), nested: false });
			} else {
				const text = this.#renderInlineTokens([token], styleContext);
				if (text) {
					lines.push({ text, nested: false });
				}
			}
		}

		return lines;
	}

	#getLongestWordWidth(text: string, maxWidth?: number): number {
		let longest = 0;
		let wordStart = -1;
		for (let i = 0; i <= text.length; i++) {
			const c = i < text.length ? text.charCodeAt(i) : 0;
			const isWs = i < text.length && (c === 0x20 || (c >= 0x09 && c <= 0x0d));
			if (isWs) {
				if (wordStart >= 0) {
					longest = Math.max(longest, visibleWidth(text.slice(wordStart, i)));
					wordStart = -1;
				}
			} else if (wordStart < 0) {
				wordStart = i;
			}
		}
		if (maxWidth === undefined) {
			return longest;
		}
		return Math.min(longest, maxWidth);
	}

	#terminalLineWidths(text: string): number[] {
		const lines = splitTerminalLines(text);
		const widths = new Array<number>(lines.length);
		for (let li = 0; li < lines.length; li++) widths[li] = visibleWidth(lines[li]!);
		return widths;
	}

	#wrapCellText(text: string, maxWidth: number): string[] {
		const cellWidth = Math.max(1, maxWidth);
		const cellLines = splitTerminalLines(text);
		const result: string[] = [];
		for (let li = 0; li < cellLines.length; li++) {
			const wrapped = wrapTextWithAnsi(cellLines[li]!, cellWidth);
			for (let wi = 0; wi < wrapped.length; wi++) result.push(wrapped[wi]!);
		}
		return result;
	}

	#renderTable(
		token: TableToken,
		availableWidth: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];
		const numCols = token.header.length;

		if (numCols === 0) {
			return lines;
		}

		// Calculate border overhead: "│ " + (n-1) * " │ " + " │"
		// = 2 + (n-1) * 3 + 2 = 3n + 1
		const borderOverhead = 3 * numCols + 1;
		const availableForCells = availableWidth - borderOverhead;
		if (availableForCells < numCols) {
			const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
			if (nextTokenType && nextTokenType !== "space") {
				fallbackLines.push("");
			}
			return fallbackLines;
		}

		const maxUnbrokenWordWidth = 30;

		const naturalWidths: number[] = [];
		const minWordWidths: number[] = [];
		for (let i = 0; i < numCols; i++) {
			const headerText = this.#renderInlineTokens(token.header[i].tokens || [], styleContext);
			const headerLineWidths = this.#terminalLineWidths(headerText);
			let maxLineWidth = 0;
			for (let j = 0; j < headerLineWidths.length; j++) maxLineWidth = Math.max(maxLineWidth, headerLineWidths[j]);
			naturalWidths[i] = maxLineWidth;
			minWordWidths[i] = Math.max(1, this.#getLongestWordWidth(headerText, maxUnbrokenWordWidth));
		}
		for (let ri = 0; ri < token.rows.length; ri++) {
			const row = token.rows[ri]!;
			for (let i = 0; i < row.length; i++) {
				const cellText = this.#renderInlineTokens(row[i]!.tokens || [], styleContext);
				const cellLineWidths = this.#terminalLineWidths(cellText);
				let maxCellWidth = naturalWidths[i] || 0;
				for (let j = 0; j < cellLineWidths.length; j++) maxCellWidth = Math.max(maxCellWidth, cellLineWidths[j]);
				naturalWidths[i] = maxCellWidth;
				minWordWidths[i] = Math.max(
					minWordWidths[i] || 1,
					this.#getLongestWordWidth(cellText, maxUnbrokenWordWidth),
				);
			}
		}

		let minColumnWidths = minWordWidths;
		let minCellsWidth = 0;
		for (let i = 0; i < minColumnWidths.length; i++) minCellsWidth += minColumnWidths[i]!;

		if (minCellsWidth > availableForCells) {
			minColumnWidths = new Array(numCols).fill(1);
			const remaining = availableForCells - numCols;

			if (remaining > 0) {
				let totalWeight = 0;
				for (let i = 0; i < minWordWidths.length; i++) totalWeight += Math.max(0, minWordWidths[i]! - 1);
				const growth = new Array<number>(minWordWidths.length);
				for (let i = 0; i < minWordWidths.length; i++) {
					const weight = Math.max(0, minWordWidths[i]! - 1);
					growth[i] = totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
				}

				for (let i = 0; i < numCols; i++) {
					minColumnWidths[i] += growth[i] ?? 0;
				}

				let allocated = 0;
				for (let i = 0; i < growth.length; i++) allocated += growth[i]!;
				let leftover = remaining - allocated;
				for (let i = 0; leftover > 0 && i < numCols; i++) {
					minColumnWidths[i]++;
					leftover--;
				}
			}

			minCellsWidth = 0;
			for (let i = 0; i < minColumnWidths.length; i++) minCellsWidth += minColumnWidths[i]!;
		}

		let totalNaturalWidth = 0;
		for (let i = 0; i < naturalWidths.length; i++) totalNaturalWidth += naturalWidths[i]!;
		totalNaturalWidth += borderOverhead;
		let columnWidths: number[];

		if (totalNaturalWidth <= availableWidth) {
			columnWidths = new Array<number>(naturalWidths.length);
			for (let i = 0; i < naturalWidths.length; i++) {
				columnWidths[i] = Math.max(naturalWidths[i]!, minColumnWidths[i]!);
			}
		} else {
			let totalGrowPotential = 0;
			for (let i = 0; i < naturalWidths.length; i++) {
				totalGrowPotential += Math.max(0, naturalWidths[i]! - minColumnWidths[i]!);
			}
			const extraWidth = Math.max(0, availableForCells - minCellsWidth);
			columnWidths = new Array<number>(minColumnWidths.length);
			for (let i = 0; i < minColumnWidths.length; i++) {
				const minWidth = minColumnWidths[i]!;
				const naturalWidth = naturalWidths[i]!;
				const minWidthDelta = Math.max(0, naturalWidth - minWidth);
				let grow = 0;
				if (totalGrowPotential > 0) {
					grow = Math.floor((minWidthDelta / totalGrowPotential) * extraWidth);
				}
				columnWidths[i] = minWidth + grow;
			}

			let allocated = 0;
			for (let i = 0; i < columnWidths.length; i++) allocated += columnWidths[i]!;
			let remaining = availableForCells - allocated;
			while (remaining > 0) {
				let grew = false;
				for (let i = 0; i < numCols && remaining > 0; i++) {
					if (columnWidths[i]! < naturalWidths[i]!) {
						columnWidths[i]++;
						remaining--;
						grew = true;
					}
				}
				if (!grew) {
					break;
				}
			}
		}

		const t = this.#theme.symbols.table;
		const h = t.horizontal;
		const v = t.vertical;
		// A table whose delimiter row omits a column, or a token from a source that
		// does not populate `align`, falls back to the GFM default rather than
		// indexing past the end.
		const align: TableAlign[] = new Array(numCols);
		for (let i = 0; i < numCols; i++) align[i] = token.align?.[i] ?? null;

		const borderCells = new Array<string>(columnWidths.length);
		for (let ci = 0; ci < columnWidths.length; ci++) borderCells[ci] = h.repeat(columnWidths[ci]!);
		lines.push(`${t.topLeft}${h}${borderCells.join(`${h}${t.teeDown}${h}`)}${h}${t.topRight}`);

		const headerCellLines: string[][] = new Array<string[]>(token.header.length);
		for (let ci = 0; ci < token.header.length; ci++) {
			const text = this.#renderInlineTokens(token.header[ci]!.tokens || [], styleContext);
			headerCellLines[ci] = this.#wrapCellText(text, columnWidths[ci]!);
		}
		let headerLineCount = 0;
		for (let i = 0; i < headerCellLines.length; i++)
			headerLineCount = Math.max(headerLineCount, headerCellLines[i].length);

		for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
			const rowParts = new Array<string>(headerCellLines.length);
			for (let ci = 0; ci < headerCellLines.length; ci++) {
				const text = headerCellLines[ci]![lineIdx] || "";
				rowParts[ci] = this.#theme.bold(alignCellText(text, columnWidths[ci]!, align[ci]!));
			}
			lines.push(`${v} ${rowParts.join(` ${v} `)} ${v}`);
		}

		const separatorLine = `${t.teeRight}${h}${borderCells.join(`${h}${t.cross}${h}`)}${h}${t.teeLeft}`;
		lines.push(separatorLine);

		// Render rows with wrapping. Inter-row rules are drawn only where a cell
		// wraps to multiple lines (they group the wrapped row visually); a grid
		// line after every single-line row doubles table height for nothing.
		let prevRowWrapped = false;
		for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
			const row = token.rows[rowIndex];
			const rowCellLines: string[][] = new Array<string[]>(row.length);
			for (let ci = 0; ci < row.length; ci++) {
				const text = this.#renderInlineTokens(row[ci]!.tokens || [], styleContext);
				rowCellLines[ci] = this.#wrapCellText(text, columnWidths[ci]!);
			}
			let rowLineCount = 0;
			for (let i = 0; i < rowCellLines.length; i++) rowLineCount = Math.max(rowLineCount, rowCellLines[i].length);

			if (rowIndex > 0 && (prevRowWrapped || rowLineCount > 1)) {
				lines.push(separatorLine);
			}
			prevRowWrapped = rowLineCount > 1;

			for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
				const rowParts = new Array<string>(rowCellLines.length);
				for (let ci = 0; ci < rowCellLines.length; ci++) {
					const text = rowCellLines[ci]![lineIdx] || "";
					rowParts[ci] = alignCellText(text, columnWidths[ci]!, align[ci]!);
				}
				lines.push(`${v} ${rowParts.join(` ${v} `)} ${v}`);
			}
		}

		lines.push(`${t.bottomLeft}${h}${borderCells.join(`${h}${t.teeUp}${h}`)}${h}${t.bottomRight}`);

		if (nextTokenType && nextTokenType !== "space") {
			lines.push(""); // Add spacing after table
		}
		return lines;
	}
}

interface InlineWalkContext {
	theme: MarkdownTheme;
	applyText: (text: string) => string;
	applyTextWithNewlines: (text: string) => string;
	renderLeafText: (text: string) => string;
	stylePrefix: string;
	swatchGlyph: string | null;
	hyperlinks: boolean;
	useHtmlState: boolean;
	handleBlocks: boolean;
	stripTrailingPrefix: boolean;
	renderNested: (tokens: Token[]) => string;
}

function walkInlineTokens(tokens: Token[], ctx: InlineWalkContext): string {
	let result = "";
	let trimLeadingWhitespace = false;
	const htmlState = ctx.useHtmlState ? createHtmlNormalizationState() : null;
	const markContent = (text: string): void => {
		if (htmlState) markCurrentHtmlItemContent(htmlState, text);
	};
	const appendDefaultText = (token: Token): void => {
		if ("text" in token && typeof token.text === "string") {
			const rawText = trimLeadingWhitespace ? token.text.replace(/^\s+/, "") : token.text;
			const text = normalizeHtmlEntitiesForTerminal(rawText);
			trimLeadingWhitespace = false;
			markContent(text);
			result += ctx.applyTextWithNewlines(text);
		}
	};

	const collapsedTokens = collapseInlineHtml(tokens);
	for (let ti = 0; ti < collapsedTokens.length; ti++) {
		const token = collapsedTokens[ti]!;
		if (isMathToken(token)) {
			markContent(token.text);
			result += ctx.applyTextWithNewlines(renderMathToken(token.text));
			continue;
		}
		switch (token.type) {
			case "text": {
				const rawText = trimLeadingWhitespace ? token.text.replace(/^\s+/, "") : token.text;
				const text = normalizeHtmlEntitiesForTerminal(rawText);
				trimLeadingWhitespace = false;
				markContent(text);
				if (token.tokens) markContent(plainInlineTokens(token.tokens));
				if (token.tokens && token.tokens.length > 0) {
					result += ctx.renderNested(token.tokens);
				} else {
					result += ctx.renderLeafText(text);
				}
				break;
			}

			case "paragraph":
				if (ctx.handleBlocks) {
					markContent(plainInlineTokens(token.tokens || []));
					result += ctx.renderNested(token.tokens || []);
				} else {
					appendDefaultText(token);
				}
				break;

			case "strong": {
				markContent(plainInlineTokens(token.tokens || []));
				const boldContent = ctx.renderNested(token.tokens || []);
				result += ctx.theme.bold(boldContent) + ctx.stylePrefix;
				break;
			}

			case "em": {
				const italicContent = ctx.renderNested(token.tokens || []);
				markContent(plainInlineTokens(token.tokens || []));
				result += ctx.theme.italic(italicContent) + ctx.stylePrefix;
				break;
			}

			case "codespan": {
				markContent(token.text);
				const swatch = ctx.swatchGlyph ? codespanSwatch(token.text, ctx.swatchGlyph) : "";
				result += swatch + ctx.theme.code(token.text) + ctx.stylePrefix;
				break;
			}

			case "link": {
				markContent(token.text);
				const linkText = ctx.renderNested(token.tokens || []);
				const styledLinkText = ctx.theme.link(ctx.theme.underline(linkText));
				if (!ctx.hyperlinks) {
					result += styledLinkText + ctx.stylePrefix;
					break;
				}
				const clickableLinkText = formatHyperlink(styledLinkText, token.href);
				// If link text matches href, only show the link once. Compare raw text
				// (token.text) not styled text (linkText) since linkText has ANSI codes.
				// For mailto: links, strip the prefix before comparing (autolinked emails
				// have text="foo@bar.com" but href="mailto:foo@bar.com").
				const href = token.href;
				const hrefForComparison = href.startsWith("mailto:") ? href.slice(7) : href;
				if (token.text === token.href || token.text === hrefForComparison) {
					result += clickableLinkText + ctx.stylePrefix;
				} else {
					const styledLinkUrl = ctx.theme.linkUrl(` (${token.href})`);
					result += clickableLinkText + formatHyperlink(styledLinkUrl, token.href) + ctx.stylePrefix;
				}
				break;
			}

			case "br":
				if (ctx.handleBlocks) {
					result += "\n";
					trimLeadingWhitespace = true;
				} else {
					appendDefaultText(token);
				}
				break;

			case "del": {
				const delContent = ctx.renderNested(token.tokens || []);
				markContent(plainInlineTokens(token.tokens || []));
				result += ctx.theme.strikethrough(delContent) + ctx.stylePrefix;
				break;
			}

			case "html":
				if ("raw" in token && typeof token.raw === "string") {
					const cleaned = normalizeHtmlForTerminal(token.raw, htmlState ?? undefined);
					result += ctx.applyTextWithNewlines(cleaned);
					if (ctx.handleBlocks) {
						if (cleaned.endsWith("\n")) {
							trimLeadingWhitespace = true;
						} else if (cleaned.length > 0) {
							trimLeadingWhitespace = false;
						}
					}
				}
				break;

			default:
				appendDefaultText(token);
		}
	}

	// Strip dangling re-opened-default SGR prefix left over from the last inline
	// token (strong/em/codespan/link/del/etc.) so the emitted line self-terminates
	// at its last styled segment instead of carrying an unmatched SGR open into
	// the next line. Matches upstream behavior.
	if (ctx.stripTrailingPrefix) {
		while (ctx.stylePrefix && result.endsWith(ctx.stylePrefix)) {
			result = result.slice(0, -ctx.stylePrefix.length);
		}
	}

	return result;
}

export function renderInlineMarkdown(text: string, mdTheme: MarkdownTheme, baseColor?: (t: string) => string): string {
	if (typeof text !== "string") return (baseColor ?? (t => t))(text != null ? String(text) : "");
	const tokens = markdownParser.lexer(text);
	const applyText = baseColor ?? ((t: string) => t);
	let result = "";
	for (let ti = 0; ti < tokens.length; ti++) {
		const token = tokens[ti]!;
		if (isMathToken(token)) {
			result += applyText(renderMathToken(token.text));
			continue;
		}
		if (token.type === "paragraph" && token.tokens) {
			result += renderInlineTokens(token.tokens, mdTheme, applyText);
		} else if (token.type === "list") {
			const items = token.items;
			for (let ii = 0; ii < items.length; ii++) {
				if (ii > 0) result += applyText(" ");
				const item = items[ii]!;
				const prefix = token.ordered ? `${(token.start || 1) + ii}. ` : "• ";
				const content = item.tokens ? renderInlineTokens(item.tokens, mdTheme, applyText) : applyText(item.text);
				result += `${applyText(prefix)}${content}`;
			}
		} else if ("text" in token && typeof token.text === "string") {
			result += applyText(normalizeHtmlEntitiesForTerminal(token.text));
		}
	}
	return result;
}

function renderInlineTokens(
	tokens: Token[],
	mdTheme: MarkdownTheme,
	applyText: (t: string) => string,
	depth = 0,
): string {
	// Same O(n^2) ANSI-wrapping hazard as Markdown#renderInlineTokens: deeply
	// nested emphasis (`**`×N) recurses N deep, each level re-wrapping. Past the
	// shared cap, flatten to styled plain text (O(n), no per-level wrapping).
	if (depth >= Markdown.MAX_INLINE_DEPTH) {
		const plain = plainInlineTokens(tokens);
		return plain === "" ? "" : applyText(plain);
	}
	// Thin adapter over the shared grammar walker: no color swatches, no OSC-8
	// hyperlinks, no HTML-normalization state, no block cases — the single-line
	// inline subset. `stylePrefix` is `applyText("")` (the base-color reset the
	// former copy appended after each styled span).
	return walkInlineTokens(tokens, {
		theme: mdTheme,
		applyText,
		applyTextWithNewlines: applyText,
		renderLeafText: applyText,
		stylePrefix: applyText(""),
		swatchGlyph: null,
		hyperlinks: false,
		useHtmlState: false,
		handleBlocks: false,
		stripTrailingPrefix: false,
		renderNested: (subTokens: Token[]) => renderInlineTokens(subTokens, mdTheme, applyText, depth + 1),
	});
}
