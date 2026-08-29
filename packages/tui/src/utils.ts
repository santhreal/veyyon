import {
	Ellipsis,
	type ExtractSegmentsResult,
	extractSegments as nativeExtractSegments,
	setHangulCompatJamoWidthOverride as nativeSetHangulCompatJamoWidthOverride,
	sliceWithWidth as nativeSliceWithWidth,
	truncateToWidth as nativeTruncateToWidth,
	wrapTextWithAnsi as nativeWrapTextWithAnsi,
	type SliceResult,
} from "@veyyon/natives";
import { collapseWhitespace } from "@veyyon/utils/collapse-whitespace";
import { clamp } from "@veyyon/utils/math";
import { DEFAULT_TAB_WIDTH } from "@veyyon/utils/tab-spacing";

export { Ellipsis } from "@veyyon/natives";

export { clamp, clampLow } from "@veyyon/utils/math";
export { DEFAULT_TAB_WIDTH } from "@veyyon/utils/tab-spacing";

import { ESC, OSC, OSC66, SGR_BG_RESET, SGR_RESET, SGR_RESET_SHORT, sgrSequence } from "./ansi";

export type HangulCompatibilityJamoWidth = "platform" | "unicode" | 1 | 2;

let hangulCompatibilityJamoWidth: HangulCompatibilityJamoWidth = "platform";

function nativeHangulCompatibilityJamoOverride(width: HangulCompatibilityJamoWidth): number {
	if (width === "unicode") return 3;
	if (typeof width === "number") return width;
	return 0;
}

function getHangulCompatibilityJamoWidth(): HangulCompatibilityJamoWidth {
	return hangulCompatibilityJamoWidth;
}

export function setHangulCompatibilityJamoWidth(width: HangulCompatibilityJamoWidth): boolean {
	const changed = hangulCompatibilityJamoWidth !== width;
	hangulCompatibilityJamoWidth = width;
	nativeSetHangulCompatJamoWidthOverride(nativeHangulCompatibilityJamoOverride(width));
	return changed;
}

export function resetHangulCompatibilityJamoWidthForTests(): void {
	hangulCompatibilityJamoWidth = "platform";
	nativeSetHangulCompatJamoWidthOverride(0);
}

export type TextSizingScale = 1 | 2 | 3;
export type TextSizingVerticalAlign = "top" | "bottom" | "center";
export type TextSizingHorizontalAlign = "left" | "right" | "center";

export interface TextSizingOptions {
	scale?: TextSizingScale;
	widthCells?: number;
	verticalAlign?: TextSizingVerticalAlign;
	horizontalAlign?: TextSizingHorizontalAlign;
}

const OSC66_UNSAFE = /[\x00-\x1f\x7f-\x9f]/u;
const OSC66_UNSAFE_GLOBAL = /[\x00-\x1f\x7f-\x9f]/gu;

function textSizingVerticalAlignValue(align: TextSizingVerticalAlign | undefined): number | undefined {
	switch (align) {
		case "top":
			return 0;
		case "bottom":
			return 1;
		case "center":
			return 2;
		default:
			return undefined;
	}
}

function textSizingHorizontalAlignValue(align: TextSizingHorizontalAlign | undefined): number | undefined {
	switch (align) {
		case "left":
			return 0;
		case "right":
			return 1;
		case "center":
			return 2;
		default:
			return undefined;
	}
}

export function encodeTextSized(text: string, options: TextSizingOptions = {}): string {
	const metadata: string[] = [];
	if (options.scale !== undefined) metadata.push(`s=${options.scale}`);
	if (options.widthCells !== undefined && Number.isFinite(options.widthCells)) {
		metadata.push(`w=${Math.max(0, Math.trunc(options.widthCells))}`);
	}
	const verticalAlign = textSizingVerticalAlignValue(options.verticalAlign);
	if (verticalAlign !== undefined) metadata.push(`v=${verticalAlign}`);
	const horizontalAlign = textSizingHorizontalAlignValue(options.horizontalAlign);
	if (horizontalAlign !== undefined) metadata.push(`h=${horizontalAlign}`);

	const safeText = OSC66_UNSAFE.test(text) ? text.replace(OSC66_UNSAFE_GLOBAL, " ") : text;
	return `\x1b]66;${metadata.join(":")};${safeText}\x1b\\`;
}

export function sliceWithWidth(line: string, startCol: number, length: number, strict?: boolean | null): SliceResult {
	return nativeSliceWithWidth(line, startCol, length, strict ?? null, DEFAULT_TAB_WIDTH);
}

export function truncateToWidth(
	text: string,
	maxWidth: number,
	ellipsisKind?: Ellipsis | null | "",
	pad?: boolean | null,
): string {
	maxWidth = maxWidth >= 0x7fff_ffff ? 0x7fff_ffff : Math.max(0, maxWidth | 0);
	if (!pad && text.length * 3 <= maxWidth) {
		return text;
	}
	return nativeTruncateToWidth(
		text,
		maxWidth,
		(typeof ellipsisKind === "string" ? Ellipsis.Omit : ellipsisKind) ?? Ellipsis.Unicode,
		pad ?? false,
		DEFAULT_TAB_WIDTH,
	);
}

export function centerLine(line: string, width: number): string {
	const lineWidth = visibleWidth(line);
	if (lineWidth >= width) return truncateToWidth(line, width);
	const left = Math.floor((width - lineWidth) / 2);
	return padding(left) + line + padding(width - left - lineWidth);
}

export function normalizeWrapInput(text: string): string {
	return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

export function wrapTextWithAnsi(text: string, width: number): string[] {
	return nativeWrapTextWithAnsi(normalizeWrapInput(text), width, DEFAULT_TAB_WIDTH);
}

const SGR_SEQUENCE_GLOBAL = sgrSequence("g");

function compactSgrCarry(carry: string): string {
	const shortReset = carry.lastIndexOf(SGR_RESET_SHORT);
	const longReset = carry.lastIndexOf(SGR_RESET);
	const cut = Math.max(
		shortReset === -1 ? -1 : shortReset + SGR_RESET_SHORT.length,
		longReset === -1 ? -1 : longReset + SGR_RESET.length,
	);
	return cut === -1 ? carry : carry.slice(cut);
}

export function reopenBackgroundAfterResets(text: string, background: string): string {
	if (!text.includes(ESC)) return text;
	return text
		.replaceAll(SGR_RESET, `${SGR_RESET}${background}`)
		.replaceAll(SGR_RESET_SHORT, `${SGR_RESET_SHORT}${background}`)
		.replaceAll(SGR_BG_RESET, `${SGR_BG_RESET}${background}`);
}

export function sgrCarryAfter(carry: string, text: string): string {
	if (!text.includes(ESC)) return compactSgrCarry(carry);
	return compactSgrCarry(carry + (text.match(SGR_SEQUENCE_GLOBAL)?.join("") ?? ""));
}

export function extractSegments(
	line: string,
	beforeEnd: number,
	afterStart: number,
	afterLen: number,
	strictAfter: boolean,
): ExtractSegmentsResult {
	return nativeExtractSegments(line, beforeEnd, afterStart, afterLen, strictAfter, DEFAULT_TAB_WIDTH);
}

const SPACE_BUFFER = " ".repeat(512);
const TAB_SPACES = " ".repeat(DEFAULT_TAB_WIDTH);
const MAX_PADDING = 1 << 20; // 1,048,576

export function replaceTabs(text: string): string {
	return text.includes("\t") ? text.replaceAll("\t", TAB_SPACES) : text;
}

export function sanitizeSingleLine(text: string): string {
	return collapseWhitespace(replaceTabs(text));
}

export function padding(n: number): string {
	if (!(n >= 1)) return "";
	if (n <= 512) return SPACE_BUFFER.slice(0, n);
	return " ".repeat(n > MAX_PADDING ? MAX_PADDING : n);
}

export function padLineToWidth(line: string, width: number): string {
	return truncateToWidth(line, width, undefined, true);
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function getSegmenter(): Intl.Segmenter {
	return segmenter;
}

const OSC66_SPAN_REGEX = /\x1b\]66;([^;\x07\x1b]*);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

function parseOsc66MetaValue(value: string): number | undefined {
	if (value.length === 0) return undefined;
	let parsed = 0;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 0x30 || code > 0x39) return undefined;
		parsed = parsed * 10 + (code - 0x30);
		if (parsed >= MAX_OSC66_META_VALUE) return MAX_OSC66_META_VALUE;
	}
	return parsed;
}

const MAX_OSC66_META_VALUE = 0xffff_ffff;

function countTabs(text: string): number {
	let count = 0;
	for (let index = text.indexOf(TAB); index !== -1; index = text.indexOf(TAB, index + 1)) count++;
	return count;
}

const OSC_SEQUENCE_REGEX = /\x1b\][0-9]+;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

const OSC_STRIP_MARKER = "\x1b\\";

const UNRECOGNIZED_ESCAPE_SEQUENCE =
	/\x1b[PX^_][\s\S]*?(?:\x1b\\|\x07)|\x1b[\x20-\x2f]+[\x30-\x7e]|\x1b[\x30-\x4f\x51-\x57\x59-\x5a\x5c\x60-\x7e]/g;
const TAB = "\t";
const LONG_WIDTH_FAST_PATH_MIN = 128;

const STRING_WIDTH_OPTS = { countAnsiEscapeCodes: false, ambiguousIsNarrow: true } as const;

const HANGUL_COMPAT_JAMO_REGEX = /[\u3131-\u318e]/;
const HANGUL_COMPAT_JAMO_GLOBAL_REGEX = /[\u3131-\u318e]/g;
const HANGUL_FILLER_CODE_POINT = 0x3164;
const HANGUL_COMPAT_JAMO_BUN_WIDTH = 2;

function hangulCompatibilityJamoTargetWidth(): 1 | 2 | null {
	switch (hangulCompatibilityJamoWidth) {
		case 1:
			return 1;
		case 2:
			return 2;
		case "unicode":
			return null;
		default:
			return process.platform === "darwin" ? 1 : null;
	}
}

function correctHangulCompatibilityJamoWidth(width: number, str: string): number {
	if (!HANGUL_COMPAT_JAMO_REGEX.test(str)) return width;
	const target = hangulCompatibilityJamoTargetWidth();
	let corrected = width;
	HANGUL_COMPAT_JAMO_GLOBAL_REGEX.lastIndex = 0;
	for (let m = HANGUL_COMPAT_JAMO_GLOBAL_REGEX.exec(str); m !== null; m = HANGUL_COMPAT_JAMO_GLOBAL_REGEX.exec(str)) {
		const unicodeWidth = m[0].codePointAt(0) === HANGUL_FILLER_CODE_POINT ? 0 : 2;
		const finalWidth = target === null || (unicodeWidth === 0 && target > 1) ? unicodeWidth : target;
		corrected += finalWidth - HANGUL_COMPAT_JAMO_BUN_WIDTH;
	}
	return corrected;
}

const OVERCOUNTED_MARK_PROBE = /\u0488|\u0489|[\ua670-\ua672]|\u20e3|\ufe0f/;

const ZERO_WIDTH_ENCLOSING_MARKS = /[\u0488\u0489\ua670-\ua672]/g;

const KEYCAP_COMBINER_WITHOUT_KEYCAP = /(?<![0-9#*]\ufe0f)\u20e3/g;

const VARIATION_SELECTOR = /\ufe0f/g;

function hasVisibleBase(text: string, offset: number): boolean {
	if (offset === 0) return false;
	const low = text.charCodeAt(offset - 1);
	const isTrailSurrogate = low >= 0xdc00 && low <= 0xdfff;
	const start = isTrailSurrogate && offset >= 2 ? offset - 2 : offset - 1;
	return Bun.stringWidth(text.slice(start, offset), STRING_WIDTH_OPTS) > 0;
}

const CSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function stripOvercountedMarks(text: string): string {
	return text
		.replace(KEYCAP_COMBINER_WITHOUT_KEYCAP, "")
		.replace(ZERO_WIDTH_ENCLOSING_MARKS, "")
		.replace(VARIATION_SELECTOR, (selector, offset: number, whole: string) =>
			hasVisibleBase(whole, offset) ? selector : "",
		);
}

function correctedBunWidth(text: string): number {
	if (!OVERCOUNTED_MARK_PROBE.test(text)) {
		const measured = text.includes(ESC) ? text.replace(UNRECOGNIZED_ESCAPE_SEQUENCE, "") : text;
		return correctHangulCompatibilityJamoWidth(Bun.stringWidth(measured, STRING_WIDTH_OPTS), measured);
	}
	if (!text.includes(ESC)) return correctedRunWidth(text);
	let total = 0;
	const runs = text.split(ESCAPE_SEQUENCE_BOUNDARY);
	for (let ri = 0; ri < runs.length; ri++) {
		if (runs[ri]) total += correctedRunWidth(runs[ri]!);
	}
	return total;
}

const ESCAPE_SEQUENCE_BOUNDARY = new RegExp(`${CSI_SEQUENCE.source}|${UNRECOGNIZED_ESCAPE_SEQUENCE.source}`, "g");

function correctedRunWidth(run: string): number {
	const measured = stripOvercountedMarks(run);
	return correctHangulCompatibilityJamoWidth(Bun.stringWidth(measured, STRING_WIDTH_OPTS), measured);
}

export function visibleWidth(str: string): number {
	if (!str) return 0;

	if (str.length >= LONG_WIDTH_FAST_PATH_MIN && !str.includes(ESC)) {
		let width = correctedBunWidth(str);

		let tabCount = 0;
		for (let tabIndex = str.indexOf(TAB); tabIndex !== -1; tabIndex = str.indexOf(TAB, tabIndex + 1)) {
			tabCount++;
		}
		if (tabCount > 0) width += tabCount * DEFAULT_TAB_WIDTH;
		return width;
	}

	let tabCount = 0;
	let i = 0;
	for (; i < str.length; i++) {
		const code = str.charCodeAt(i);
		if (code < 0x20 || code > 0x7e) {
			if (code === 0x09) {
				tabCount++;
				continue;
			}
			break;
		}
	}
	if (i === str.length) {
		return tabCount === 0 ? str.length : str.length + tabCount * (DEFAULT_TAB_WIDTH - 1);
	}

	if (tabCount === 0) {
		let tabIndex = str.indexOf(TAB, i + 1);
		if (tabIndex !== -1) {
			tabCount = 1;
			for (tabIndex = str.indexOf(TAB, tabIndex + 1); tabIndex !== -1; tabIndex = str.indexOf(TAB, tabIndex + 1)) {
				tabCount++;
			}
		}
	} else {
		for (let tabIndex = str.indexOf(TAB, i + 1); tabIndex !== -1; tabIndex = str.indexOf(TAB, tabIndex + 1)) {
			tabCount++;
		}
	}

	const strippedStr = str.includes(OSC) ? str.replace(OSC_SEQUENCE_REGEX, OSC_STRIP_MARKER) : str;
	let width = correctedBunWidth(strippedStr);

	if (strippedStr !== str) tabCount = countTabs(strippedStr);

	if (tabCount > 0) width += tabCount * DEFAULT_TAB_WIDTH;

	if (str.includes(OSC66, i)) {
		OSC66_SPAN_REGEX.lastIndex = 0;
		for (let m = OSC66_SPAN_REGEX.exec(str); m !== null; m = OSC66_SPAN_REGEX.exec(str)) {
			let scale = 1;
			let explicit: number | undefined;
			const parts = m[1].split(":");
			for (let pi = 0; pi < parts.length; pi++) {
				const part = parts[pi]!;
				if (part.indexOf("=") !== 1) continue;
				const value = parseOsc66MetaValue(part.slice(2));
				if (value === undefined) continue;
				if (part[0] === "s") {
					if (value >= 1 && value <= 7) scale = value;
				} else if (part[0] === "w" && value > 0) {
					explicit = value;
				}
			}
			const payloadWidth = explicit ?? correctedBunWidth(m[2]) + countTabs(m[2]) * DEFAULT_TAB_WIDTH;
			width += scale * payloadWidth;
		}
	}

	return width;
}

const THAI_LAO_AM_GLOBAL_REGEX = /[\u0e33\u0eb3]/g;

export function normalizeTerminalOutput(str: string): string {
	if (str.indexOf("\u0e33") === -1 && str.indexOf("\u0eb3") === -1) return str;
	return str.replace(THAI_LAO_AM_GLOBAL_REGEX, char => (char === "\u0e33" ? "\u0e4d\u0e32" : "\u0ecd\u0eb2"));
}

export type WordNavKind = "whitespace" | "delimiter" | "cjk" | "word" | "other";

const WORD_NAV_RE_WHITESPACE = /^\p{White_Space}$/u;
const WORD_NAV_RE_PUNCT = /^\p{P}$/u;
const WORD_NAV_RE_SYMBOL = /^\p{S}$/u;
const WORD_NAV_RE_LETTER = /^\p{L}$/u;
const WORD_NAV_RE_NUMBER = /^\p{N}$/u;
const WORD_NAV_RE_HAN = /^\p{Script=Han}$/u;
const WORD_NAV_RE_HIRAGANA = /^\p{Script=Hiragana}$/u;
const WORD_NAV_RE_KATAKANA = /^\p{Script=Katakana}$/u;
const WORD_NAV_RE_HANGUL = /^\p{Script=Hangul}$/u;

function firstCodePointChar(str: string): string {
	const cp = str.codePointAt(0);
	if (cp === undefined) return "";
	return String.fromCodePoint(cp);
}

export function getWordNavKind(grapheme: string): WordNavKind {
	if (!grapheme) return "other";
	const ch = firstCodePointChar(grapheme);
	if (!ch) return "other";
	if (WORD_NAV_RE_WHITESPACE.test(ch)) return "whitespace";
	if (ch === "_") return "word";
	if (WORD_NAV_RE_PUNCT.test(ch) || WORD_NAV_RE_SYMBOL.test(ch)) return "delimiter";
	if (
		WORD_NAV_RE_HAN.test(ch) ||
		WORD_NAV_RE_HIRAGANA.test(ch) ||
		WORD_NAV_RE_KATAKANA.test(ch) ||
		WORD_NAV_RE_HANGUL.test(ch)
	) {
		return "cjk";
	}
	if (WORD_NAV_RE_LETTER.test(ch) || WORD_NAV_RE_NUMBER.test(ch)) return "word";
	return "other";
}

const WORD_NAV_JOINERS = new Set(["'", "’", "-", "‐", "‑"]);

function isWordNavJoiner(grapheme: string): boolean {
	const ch = firstCodePointChar(grapheme);
	return WORD_NAV_JOINERS.has(ch);
}

function floorToGraphemeBoundary(text: string, cursor: number): number {
	if (cursor <= 0) return 0;
	let prev = 0;
	for (const { segment } of segmenter.segment(text)) {
		const next = prev + segment.length;
		if (next >= cursor) return next === cursor ? cursor : prev;
		prev = next;
	}
	return prev;
}

export function moveWordLeft(text: string, cursor: number): number {
	const len = text.length;
	if (len === 0) return 0;
	let i = floorToGraphemeBoundary(text, clamp(cursor, 0, len));
	if (i === 0) return 0;

	const graphemes = Array.from(segmenter.segment(text.slice(0, i)));
	if (graphemes.length === 0) return 0;

	while (graphemes.length > 0 && getWordNavKind(graphemes[graphemes.length - 1]?.segment || "") === "whitespace") {
		i -= graphemes.pop()?.segment.length || 0;
	}
	if (i === 0 || graphemes.length === 0) return i;

	const kind = getWordNavKind(graphemes[graphemes.length - 1]?.segment || "");
	if (kind === "delimiter" || kind === "cjk") {
		while (graphemes.length > 0 && getWordNavKind(graphemes[graphemes.length - 1]?.segment || "") === kind) {
			i -= graphemes.pop()?.segment.length || 0;
		}
		return i;
	}

	if (kind === "word") {
		let hasRightWord = false;
		while (graphemes.length > 0) {
			const g = graphemes[graphemes.length - 1]?.segment || "";
			const k = getWordNavKind(g);
			if (k === "word") {
				hasRightWord = true;
				i -= graphemes.pop()?.segment.length || 0;
				continue;
			}
			if (hasRightWord && k === "delimiter" && isWordNavJoiner(g)) {
				const left = graphemes[graphemes.length - 2]?.segment || "";
				if (getWordNavKind(left) === "word") {
					i -= graphemes.pop()?.segment.length || 0;
					continue;
				}
			}
			break;
		}
		return i;
	}

	i -= graphemes.pop()?.segment.length || 0;
	return Math.max(0, i);
}

export function moveWordRight(text: string, cursor: number): number {
	const len = text.length;
	if (len === 0) return 0;
	let i = floorToGraphemeBoundary(text, clamp(cursor, 0, len));
	if (i === len) return len;

	const iterator = segmenter.segment(text.slice(i))[Symbol.iterator]();
	let next = iterator.next();

	while (!next.done && getWordNavKind(next.value.segment) === "whitespace") {
		i += next.value.segment.length;
		next = iterator.next();
	}
	if (next.done) return i;

	const firstKind = getWordNavKind(next.value.segment);
	if (firstKind === "delimiter" || firstKind === "cjk") {
		while (!next.done && getWordNavKind(next.value.segment) === firstKind) {
			i += next.value.segment.length;
			next = iterator.next();
		}
		return i;
	}

	if (firstKind === "word") {
		let hasLeftWord = false;
		while (!next.done) {
			const segment = next.value.segment;
			const k = getWordNavKind(segment);
			if (k === "word") {
				hasLeftWord = true;
				i += segment.length;
				next = iterator.next();
				continue;
			}
			if (hasLeftWord && k === "delimiter" && isWordNavJoiner(segment)) {
				const lookahead = iterator.next();
				if (!lookahead.done && getWordNavKind(lookahead.value.segment) === "word") {
					i += segment.length;
					next = lookahead;
					continue;
				}
			}
			break;
		}
		return i;
	}

	return i + next.value.segment.length;
}

export function applyBackgroundToLine(line: string, width: number, bgFn: (text: string) => string): string {
	const visibleLen = visibleWidth(line);
	const paddingNeeded = Math.max(0, width - visibleLen);

	const withPadding = line + padding(paddingNeeded);
	return bgFn(withPadding);
}

export function sliceByColumn(line: string, startCol: number, length: number, strict = false): string {
	return sliceWithWidth(line, startCol, length, strict).text;
}

let globalTight = false;

export function setTuiTight(tight: boolean): void {
	globalTight = tight;
}

export function isTuiTight(): boolean {
	return globalTight;
}

export function getPaddingX(basePadding: number): number {
	return globalTight ? Math.max(0, basePadding - 1) : basePadding;
}
