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

// Wire encoding for the native override (see crates/veyyon-natives text.rs):
// 0 = platform default, 1 = narrow, 2 = wide, 3 = unicode (no correction).
function nativeHangulCompatibilityJamoOverride(width: HangulCompatibilityJamoWidth): number {
	if (width === "unicode") return 3;
	if (typeof width === "number") return width;
	return 0;
}

export function getHangulCompatibilityJamoWidth(): HangulCompatibilityJamoWidth {
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

/**
 * Encode a plain-text span using Kitty's OSC 66 text-sizing protocol. The TUI
 * emits only safe UTF-8 payloads and ST terminators so its ANSI parser and the
 * terminal agree on span boundaries.
 */
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

/**
 * Take the run of `line` covering columns `[startCol, startCol + length)`.
 *
 * Always cuts on grapheme boundaries, so no caller can emit half a cluster.
 * That means the result's width does not always equal `length`, and the
 * difference is what `strict` selects:
 *
 * - `strict` false (the DEFAULT): a grapheme straddling either edge is kept
 *   whole, so `width` may EXCEED `length` by up to one grapheme's width. A
 *   caller sizing a viewport by `length` alone can overflow it by a cell.
 * - `strict` true: such a grapheme is dropped instead, so `width <= length`
 *   always, at the cost of leaving a blank column.
 *
 * Starting inside a wide grapheme drops that grapheme rather than emitting its
 * second half. Locked by `packages/tui/test/grapheme-boundary-integrity.test.ts`.
 */
export function sliceWithWidth(line: string, startCol: number, length: number, strict?: boolean | null): SliceResult {
	return nativeSliceWithWidth(line, startCol, length, strict ?? null, DEFAULT_TAB_WIDTH);
}

export function truncateToWidth(
	text: string,
	maxWidth: number,
	ellipsisKind?: Ellipsis | null | "",
	pad?: boolean | null,
): string {
	// Normalize the width. `| 0` alone truncates fractions and coerces non-numbers,
	// but it wraps at 2^31: `2**31 | 0`, `Infinity | 0`, and `NaN | 0` all become 0
	// (or negative), so an "unbounded" call like `truncateToWidth(text, Infinity)`
	// would silently return the empty string instead of the full text. Cap any
	// width at or above INT32_MAX at INT32_MAX (which the native path accepts and
	// the fast path below treats as "no truncation" for every realistic string).
	maxWidth = maxWidth >= 0x7fff_ffff ? 0x7fff_ffff : Math.max(0, maxWidth | 0);
	// Fast path: every UTF-16 unit is at most 3 cells wide, so a string whose
	// `length * 3` already fits within `safeWidth` cannot need truncation.
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

/** Horizontally center `line` in `width` cells; truncates when the line is wider. */
export function centerLine(line: string, width: number): string {
	const lineWidth = visibleWidth(line);
	if (lineWidth >= width) return truncateToWidth(line, width);
	const left = Math.floor((width - lineWidth) / 2);
	return padding(left) + line + padding(width - left - lineWidth);
}

/**
 * Normalize CR and CRLF to LF for wrapping. The native wrapper breaks only
 * on LF, so a `\r\n` source leaves a trailing `\r` on the wrapped row and a
 * bare `\r` stays embedded — either one moves the terminal cursor to column 0
 * and corrupts the line. Universal-newline normalization (`\r\n` and bare `\r`
 * both become `\n`) keeps every produced row a single clean line. Guarded on
 * `includes` so the overwhelmingly common CR-free text pays one scan rather
 * than a regex rewrite. Exported so callers that index into the text they
 * pass to {@link wrapTextWithAnsi} can align their offsets with what the
 * wrapper actually wraps.
 */
export function normalizeWrapInput(text: string): string {
	return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

export function wrapTextWithAnsi(text: string, width: number): string[] {
	return nativeWrapTextWithAnsi(normalizeWrapInput(text), width, DEFAULT_TAB_WIDTH);
}

const SGR_SEQUENCE_GLOBAL = sgrSequence("g");

/**
 * Everything before the last full SGR reset is dead state — drop it so a
 * re-played carry stays bounded by the live style run instead of the whole
 * code history.
 */
export function compactSgrCarry(carry: string): string {
	// Both spellings of the reset, and the cut is measured from each constant's own length
	// rather than from a literal 3 and 4. The lengths were inline next to inline bytes, so
	// changing either spelling meant remembering to change a number three lines away.
	const shortReset = carry.lastIndexOf(SGR_RESET_SHORT);
	const longReset = carry.lastIndexOf(SGR_RESET);
	const cut = Math.max(
		shortReset === -1 ? -1 : shortReset + SGR_RESET_SHORT.length,
		longReset === -1 ? -1 : longReset + SGR_RESET.length,
	);
	return cut === -1 ? carry : carry.slice(cut);
}

/**
 * Re-open `background` after every reset in `text`, so a painted ground survives its content.
 *
 * A component that paints a background behind a row cannot trust the row: an inner
 * `ESC [ 0 m` from a reverse-video cursor, a themed span, or a wrapped tool output clears the
 * background from that point on and punches a hole in the ground for the rest of the line. The
 * fix is to re-emit the background immediately after each reset, which is what every painter
 * here was already doing, separately.
 *
 * THREE COPIES, THREE DIFFERENT ANSWERS, which is why this is one function now.
 * `coding-agent/src/tui/output-block.ts` handled `ESC [ 0 m` and `ESC [ 49 m`,
 * `tui/src/components/editor.ts` handled only `ESC [ 0 m`, and
 * `coding-agent/src/modes/components/sun.ts` handled both but DROPPED the `ESC [ 49 m` instead
 * of keeping it. None of the three handled `ESC [ m`, the parameterless reset, which means the
 * same hole for content that happens to spell its reset the short way. Each miss is a visible
 * defect in one surface and not in the others, which is the shape a reader has no way to
 * notice from any single site.
 *
 * All three resets are KEPT and the background re-emitted after them. Keeping the reset matters
 * for `ESC [ 0 m`, which the content emitted to clear its foreground as well; for `ESC [ 49 m`
 * it makes no visible difference, because the background that follows overrides it either way,
 * and one rule is easier to read than two.
 */
export function reopenBackgroundAfterResets(text: string, background: string): string {
	return text
		.replaceAll(SGR_RESET, `${SGR_RESET}${background}`)
		.replaceAll(SGR_RESET_SHORT, `${SGR_RESET_SHORT}${background}`)
		.replaceAll(SGR_BG_RESET, `${SGR_BG_RESET}${background}`);
}

/**
 * Advance an SGR carry across `text`: the returned string, replayed at the
 * start of whatever follows `text`, restores the styling state open at its
 * end. Compacts at every step so the carry never grows past the live run.
 */
export function sgrCarryAfter(carry: string, text: string): string {
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

// Pre-allocated space buffer for padding
const SPACE_BUFFER = " ".repeat(512);
const TAB_SPACES = " ".repeat(DEFAULT_TAB_WIDTH);
// Upper bound on a single padding run. No terminal is anywhere near this wide;
// the cap exists only to keep `padding` total against an out-of-contract width
// (a bad resize delivering Infinity/NaN, or a computed width in the millions),
// which would otherwise throw in `String.prototype.repeat` (Infinity) or
// allocate multiple gigabytes (a huge finite n) — a render-path crash / DoS.
const MAX_PADDING = 1 << 20; // 1,048,576

/*
 * Replace tabs with the fixed display tab width for consistent rendering.
 */
export function replaceTabs(text: string): string {
	return text.replaceAll("\t", TAB_SPACES);
}

/**
 * Flatten text to a single trimmed line: expand tabs, collapse every run of
 * whitespace (including newlines) to one space. Used by list components that
 * render one row per item and must never let an embedded newline break the row.
 *
 * The collapse itself belongs to `collapseWhitespace` in `@veyyon/utils`, the
 * repo-wide owner of that idiom; this is the tab-expanding wrapper over it, not a
 * second implementation. It used to inline the regexes (`[\r\n]+` then `\s+`,
 * the first of which the second already covers), which is the kind of copy that
 * drifts: `ask-dialog.ts` and `transcript-render-helpers.ts` were already calling
 * `collapseWhitespace(replaceTabs(...))` by hand for the same effect, so the
 * repository had two answers to one question.
 */
export function sanitizeSingleLine(text: string): string {
	return collapseWhitespace(replaceTabs(text));
}

/**
 * Returns a string of n spaces. Uses a pre-allocated buffer for efficiency.
 */
export function padding(n: number): string {
	// `!(n >= 1)` rejects n <= 0, NaN, and -Infinity in one check.
	if (!(n >= 1)) return "";
	if (n <= 512) return SPACE_BUFFER.slice(0, n);
	return " ".repeat(n > MAX_PADDING ? MAX_PADDING : n);
}

/**
 * Fit a line to exactly `width` visible columns: truncate what overflows, then
 * pad the remainder with spaces. Truncation on a wide-character boundary can
 * leave `width - 1` visible columns, so the trailing pad is computed from the
 * truncated line's real width to guarantee the result is always exactly `width`.
 */
export function padLineToWidth(line: string, width: number): string {
	const truncated = truncateToWidth(line, width);
	return truncated + padding(width - visibleWidth(truncated));
}

// Grapheme segmenter (shared instance)
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Get the shared grapheme segmenter instance.
 */
export function getSegmenter(): Intl.Segmenter {
	return segmenter;
}

// Kitty OSC 66 text-sizing spans: `\x1b]66;<meta>;<payload>` terminated by BEL
// or ST. `Bun.stringWidth` strips the whole span (payload included) to zero
// cells, but the payload is visible and scales by the `s=` factor, so each is
// added back so width matches the native truncate/slice/wrap helpers.
//
// The metadata and the payload use the SAME class as `OSC_SEQUENCE_REGEX` below,
// which is the point rather than a coincidence: this pattern decides what to add
// BACK and that one decides what was taken away, so the moment they disagree about
// where a sequence ends, a span is either counted twice or not at all. They did
// disagree. The payload was `[\s\S]*?`, which let an escape live inside a span
// this one recognised and the stripper did not, so `\x1b]66;\x1b\\=+5;Hi\x1b\\`
// was stripped as an empty OSC and then added back as a two-cell span on top of
// the text the stripper had left visible, and the line measured two cells wider
// than the terminal drew it. Found by the width fuzz on seed 0x1234.
const OSC66_SPAN_REGEX = /\x1b\]66;([^;\x07\x1b]*);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/**
 * One OSC 66 metadata value, `2` in `s=2`, as a number, or `undefined` when the
 * value is not a run of ASCII digits and nothing.
 *
 * `Number.parseInt` is wrong here and was the bug. It takes a numeric PREFIX, so
 * `s=2x` parsed as 2; it accepts a leading sign, so `w=+5` parsed as 5; and it
 * skips leading whitespace, so `w= 5` parsed as 5. The Rust side reads the same
 * metadata with an all-digits parse and rejects every one of those, so a span the
 * native measured at its payload width re-measured here at the width the malformed
 * metadata claimed. The native truncate then left the line whole and the compositor
 * padded it to a width three cells wider than the terminal.
 *
 * The digits are read here rather than through `Number` so the two implementations
 * are the same rule rather than two spellings of it. A value with no digits at all
 * is `undefined`, which the caller treats as absent, which is what the native does.
 */
function parseOsc66MetaValue(value: string): number | undefined {
	if (value.length === 0) return undefined;
	let parsed = 0;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 0x30 || code > 0x39) return undefined;
		parsed = parsed * 10 + (code - 0x30);
		// The native accumulates in a saturating `usize` and the binding clamps the
		// answer to `u32`, so stop climbing at the same ceiling rather than letting a
		// forty-digit `w=` produce a float the native could never return.
		if (parsed >= MAX_OSC66_META_VALUE) return MAX_OSC66_META_VALUE;
	}
	return parsed;
}

/** `u32::MAX`, the ceiling the native width binding clamps to. See {@link parseOsc66MetaValue}. */
const MAX_OSC66_META_VALUE = 0xffff_ffff;

/** Tabs in `text`, which `Bun.stringWidth` counts as zero cells. */
function countTabs(text: string): number {
	let count = 0;
	for (let index = text.indexOf(TAB); index !== -1; index = text.indexOf(TAB, index + 1)) count++;
	return count;
}

/**
 * One OSC sequence: `ESC ] <ps> ; <payload>` up to its terminator, which is
 * either BEL or ST (`ESC \`). Both spellings are in use and OSC 8 hyperlinks in
 * Markdown tables arrive ST-terminated, which is what upstream #6282 fixed.
 *
 * `visibleWidth` strips these before measuring because the sequence itself
 * draws no cells, and a link counted at its escape length rather than its label
 * length pushes every column boundary after it out of place. The payload class
 * excludes both terminators so a sequence can never swallow the text that
 * follows it, and defining the pattern once keeps the escape spelling from
 * drifting between call sites. It is written with `\x07`/`\x1b` escapes rather
 * than the literal control bytes so it survives being read, copied, and
 * reviewed.
 */
const OSC_SEQUENCE_REGEX = /\x1b\][0-9]+;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * What an OSC sequence is replaced BY when it is stripped, rather than deleted.
 *
 * `ESC \` is ST, two bytes, zero cells, and it is one of the escape families both
 * the width measurement and the grapheme-run splitter already recognise, so it
 * costs nothing and it keeps the boundary.
 *
 * Keeping the boundary is the whole point. Deleting the sequence outright JOINS
 * the text on either side of it, and the native engine treats an escape as a
 * grapheme break, so the join can INVENT a cluster that neither the terminal nor
 * the native ever saw. `"9\x1b]66;;i\x1b\\️⃣"` is a `9`, a span, and a
 * keycap combiner with nothing to combine with: one cell natively. Delete the span
 * and the `9` lands against the selector, which is a real keycap, and the string
 * measured two. Found by the width fuzz on seed 0x1234. Same defect the
 * escape-run splitter in `correctedRunWidth` fixes for CSI and the Fe families;
 * this is the OSC half of it, and it has to happen here because the strip runs
 * before that splitter ever sees the text.
 */
const OSC_STRIP_MARKER = "\x1b\\";

/**
 * The escape sequences `Bun.stringWidth` does NOT recognise, which the native
 * engine strips and every terminal consumes.
 *
 * Bun handles CSI (`ESC [ ... final`) and OSC, and nothing else, so the rest of
 * ECMA-48 arrives as ordinary text and gets charged for the bytes it happens to
 * contain. Measured against the native oracle, this was eleven of the nineteen
 * escape-class disagreements between the two: `"\x1bm"` measured one cell here and
 * zero there, `"\x1b(B"` two against zero, and a DCS or APC string measured its
 * whole payload. Text a terminal never draws was widening every layout that
 * carried it.
 *
 * Three families, in the order the pattern tries them:
 *
 * 1. STRING SEQUENCES, `ESC` then one of `P` (DCS), `X` (SOS), `^` (PM) or `_`
 *    (APC), running to a `ST` or `BEL` terminator. These carry a payload, so they
 *    must be matched before the two-byte rule, which would otherwise take the
 *    introducer and leave the payload as text.
 * 2. nF SEQUENCES, `ESC` then one or more bytes in `0x20..0x2f` then a final:
 *    character-set designators such as `ESC ( B`, and `ESC # 8`.
 * 3. TWO-BYTE Fe AND Fs SEQUENCES, `ESC` then a single byte in `0x40..0x7e`. The
 *    class excludes `[` and `]`, whose sequences Bun already strips, and the four
 *    string introducers, which family 1 owns.
 *
 * NOT INCLUDED: an UNTERMINATED introducer. Bun scores `"\x1b[3"` and `"\x1b]8;;"`
 * at zero, which is what a terminal does with a sequence it is still waiting to
 * finish, and the native counts the bytes after the `ESC` instead. Those eight
 * remaining disagreements are the native's to fix, and adopting its answer here
 * would mean teaching this side to draw characters the terminal does not.
 */
const UNRECOGNIZED_ESCAPE_SEQUENCE =
	/\x1b[PX^_][\s\S]*?(?:\x1b\\|\x07)|\x1b[\x20-\x2f]+[\x30-\x7e]|\x1b[\x40-\x4f\x51-\x57\x59-\x5a\x5c\x60-\x7e]/g;
const TAB = "\t";
const LONG_WIDTH_FAST_PATH_MIN = 128;

// Pin Bun.stringWidth semantics to the native width engine and guard against Bun
// default drift: strip ANSI/OSC (don't count escape bytes) and treat
// ambiguous-width East Asian chars as narrow (1 cell), matching `unicode-width`'s
// non-CJK tables that back truncate/slice/wrap. Hoisted so no per-call alloc.
const STRING_WIDTH_OPTS = { countAnsiEscapeCodes: false, ambiguousIsNarrow: true } as const;

// Hangul Compatibility Jamo (U+3131..=U+318E). `Bun.stringWidth` follows UAX#11
// and reports these at 2 cells (the U+3164 HANGUL FILLER at 0), but the actual
// rendered width is decided by the *client* terminal (1 cell on Terminal.app /
// iTerm2, 2 on Ghostty and most Linux terminals). The width is resolved from
// the terminal identity and pushed into the native engine through
// `setHangulCompatibilityJamoWidth`; mirror the same correction here so the TS
// width stays in parity with the native truncate/slice/wrap model — and so the
// hardware cursor column lands on the actual glyph during Korean IME input.
const HANGUL_COMPAT_JAMO_REGEX = /[\u3131-\u318e]/;
const HANGUL_COMPAT_JAMO_GLOBAL_REGEX = /[\u3131-\u318e]/g;
const HANGUL_FILLER_CODE_POINT = 0x3164;
// `Bun.stringWidth` counts every code point in the Compatibility Jamo block as
// 2 cells (even the U+3164 filler that `unicode-width` treats as zero-width).
const HANGUL_COMPAT_JAMO_BUN_WIDTH = 2;

// Effective target cell width for Compatibility Jamo, or `null` to follow the
// Unicode width (no correction). Mirrors `hangul_compat_jamo_target_width` in
// crates/veyyon-natives/src/text.rs.
function hangulCompatibilityJamoTargetWidth(): 1 | 2 | null {
	switch (hangulCompatibilityJamoWidth) {
		case 1:
			return 1;
		case 2:
			return 2;
		case "unicode":
			return null;
		default:
			// "platform": macOS terminals historically render these narrow.
			return process.platform === "darwin" ? 1 : null;
	}
}

// Reconcile the `Bun.stringWidth` count for Compatibility Jamo to the native
// width engine: subtract Bun's per-jamo cell count and add back the effective
// width — the runtime target when one is active, otherwise the `unicode-width`
// value. Mirrors `char_width_corrected` / `apply_hangul_compat_jamo_delta` in
// crates/veyyon-natives/src/text.rs, including the rule that the zero-width filler
// (U+3164) is never widened past the narrow correction (a wide terminal still
// renders it at its Unicode width of 0).
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

/**
 * Marks `Bun.stringWidth` charges cells for that occupy none, and how they are removed.
 *
 * Three separate over-counts, all with the same consequence. `truncateToWidth` cuts
 * on the Rust native engine and `visibleWidth` measures here, so anywhere the two
 * disagree a span cut to fit W re-measures as more than W and the caller that sized
 * a viewport by that cut writes past the last column. These were 30 of the 37
 * measured divergences between the pair, making them by far the largest class.
 *
 * 1. FIVE ENCLOSING MARKS. `Me` is zero-width: the glyph draws around its base and
 *    advances the cursor by nothing. Bun agrees for eight of the thirteen `Me` code
 *    points and charges a cell for five Cyrillic numeral signs. Measured rather than
 *    assumed, because the set is not the whole category: U+1ABE, U+20DD..U+20E0,
 *    U+20E2 and U+20E4 already come back zero.
 * 2. KEYCAP COMBINERS WITH NO KEYCAP. A keycap is base + U+FE0F + U+20E3, where the
 *    base is a digit, `#` or `*`, and it really is two cells wide. Bun widens the
 *    cluster to two for ANY U+20E3, so `a` + U+20E3 reads as two and a lone U+20E3
 *    reads as two, where the native (and every terminal) says one and zero. Note
 *    that the U+FE0F is required: the native scores `1` + U+20E3 as one cell.
 * 3. DOUBLED VARIATION SELECTORS. One U+FE0F with nothing to modify measures zero,
 *    two in a row measure two. Degenerate input, but a real width-bound violation.
 *
 * REMOVED BEFORE MEASURING, NOT SUBTRACTED AFTERWARDS. The first version of this
 * subtracted a fixed cell per match, and the width fuzzer shrank a counterexample to
 * `"\x1b]҉"` in one run: the OSC strip below had already removed the mark from the
 * text that was measured, so subtracting for it again returned a NEGATIVE width. Any
 * arithmetic correction has that shape of bug, because it re-scans a string that is
 * not the one the number came from. Deleting the marks and re-measuring cannot: the
 * result is whatever Bun says about text that no longer contains them, and it also
 * needs no per-mark knowledge of what Bun charged.
 */
const OVERCOUNTED_MARK_PROBE = /\u0488|\u0489|[\ua670-\ua672]|\u20e3|\ufe0f/;

/** The five `Me` code points from case 1, which are always dropped. */
const ZERO_WIDTH_ENCLOSING_MARKS = /[\u0488\u0489\ua670-\ua672]/g;

/**
 * Case 2: a U+20E3 that is NOT completing a keycap sequence.
 *
 * Written as a lookbehind rather than by consuming the base, because a consuming
 * pattern cannot match two combiners in a row: the first match eats the character
 * the second one would have needed to look at, and `"\u20e3\u20e3"` kept a cell.
 */
const KEYCAP_COMBINER_WITHOUT_KEYCAP = /(?<![0-9#*]\ufe0f)\u20e3/g;

/**
 * Case 3: a U+FE0F with no visible base in front of it.
 *
 * The selector asks the character it follows to render as an emoji, so with nothing
 * to modify it draws nothing and occupies nothing, which is what the native says.
 * Bun scores that cluster at two cells, and "nothing to modify" covers more shapes
 * than it first appears: a selector at the start of the string, a second selector
 * after the first, and a selector after any zero-width mark, including a combining
 * accent, an enclosing mark, or a zero-width space that ended the previous cluster.
 * All of them were measured as two against a native zero.
 *
 * The base is classified by asking Bun for the width of the single preceding code
 * point rather than by listing Unicode categories, so the test and the count come
 * from the same table and cannot drift apart.
 */
const VARIATION_SELECTOR = /\ufe0f/g;

/** Whether the code point before `offset` renders anything for a selector to modify. */
function hasVisibleBase(text: string, offset: number): boolean {
	if (offset === 0) return false;
	const low = text.charCodeAt(offset - 1);
	const isTrailSurrogate = low >= 0xdc00 && low <= 0xdfff;
	const start = isTrailSurrogate && offset >= 2 ? offset - 2 : offset - 1;
	return Bun.stringWidth(text.slice(start, offset), STRING_WIDTH_OPTS) > 0;
}

/**
 * Every escape sequence, as a GRAPHEME CLUSTER BREAK.
 *
 * Measured, and it is the rule that makes the mark corrections agree with the
 * native oracle on styled text: `"9\ufe0f\u20e3"` is a keycap worth two cells, and
 * `"9\x1b[0m\ufe0f\u20e3"` is a `9` followed by two marks with nothing to attach to,
 * worth one. `Bun.stringWidth` deletes the escape and measures the two sides as one
 * cluster, so it answers two for both. Mark-bearing text is therefore SPLIT here and
 * each run corrected and measured on its own, rather than the escapes being deleted
 * and the remainder measured as one string, which would rejoin the cluster.
 *
 * CSI first, then the families in {@link UNRECOGNIZED_ESCAPE_SEQUENCE}, because a
 * boundary is a boundary whether or not Bun would have stripped the bytes itself.
 */
const CSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** Drop the marks Bun over-counts so the re-measure is the width they actually occupy. */
function stripOvercountedMarks(text: string): string {
	// ORDER MATTERS, and each of the three positions was forced by a counterexample.
	//
	// THE KEYCAP PASS GOES FIRST, because it is the only one that reads the ORIGINAL
	// adjacency. A keycap is three adjacent code points, so any mark between the digit
	// and the selector breaks it and the native scores `"9\u0489\ufe0f\u20e3"` at one
	// cell. Removing the enclosing mark first turned that into a well-formed keycap and
	// this function INVENTED a cell that neither oracle had.
	//
	// THE SELECTOR PASS GOES LAST, because it is the only one that asks a question
	// about what it sees rather than matching a fixed shape, and the answer is wrong
	// while an over-counted mark is still in front of it: in `"\u20dd\u20e3\ufe0f"` the
	// selector's base was a stray U+20E3, which Bun scores at two cells, so the
	// selector looked well-founded right up until the pass that deleted its base.
	return text
		.replace(KEYCAP_COMBINER_WITHOUT_KEYCAP, "")
		.replace(ZERO_WIDTH_ENCLOSING_MARKS, "")
		.replace(VARIATION_SELECTOR, (selector, offset: number, whole: string) =>
			hasVisibleBase(whole, offset) ? selector : "",
		);
}

/**
 * `Bun.stringWidth` with every correction this module owns, over the text that is
 * actually being measured.
 *
 * The one entry point, because the corrections must see the SAME string the count
 * came from. `visibleWidth` measures three different strings depending on the path
 * it takes (the input, the input with OSC sequences stripped, and each OSC 66
 * payload on its own), and a correction applied to the input while the number came
 * from one of the others is the negative-width bug described above.
 */
function correctedBunWidth(text: string): number {
	// Only mark-bearing text pays for the split. Everything else deletes the escapes
	// Bun does not recognise and keeps the single `Bun.stringWidth` call over the
	// whole string: without a mark in it, no cluster spans an escape boundary, so
	// where the runs are cut cannot change the answer and splitting would be pure
	// overhead on the render hot path.
	if (!OVERCOUNTED_MARK_PROBE.test(text)) {
		const measured = text.includes(ESC) ? text.replace(UNRECOGNIZED_ESCAPE_SEQUENCE, "") : text;
		return correctHangulCompatibilityJamoWidth(Bun.stringWidth(measured, STRING_WIDTH_OPTS), measured);
	}
	if (!text.includes(ESC)) return correctedRunWidth(text);
	let total = 0;
	for (const run of text.split(ESCAPE_SEQUENCE_BOUNDARY)) {
		if (run) total += correctedRunWidth(run);
	}
	return total;
}

/** CSI plus the families Bun leaves in place: every escape, as a run separator. */
const ESCAPE_SEQUENCE_BOUNDARY = new RegExp(`${CSI_SEQUENCE.source}|${UNRECOGNIZED_ESCAPE_SEQUENCE.source}`, "g");

/** One escape-free run: correct the marks Bun over-counts, then measure what is left. */
function correctedRunWidth(run: string): number {
	const measured = stripOvercountedMarks(run);
	return correctHangulCompatibilityJamoWidth(Bun.stringWidth(measured, STRING_WIDTH_OPTS), measured);
}

/**
 * Visible width of a string in terminal columns, excluding ANSI/OSC escapes.
 *
 * `Bun.stringWidth` does the heavy lifting (UAX#11 width tables + ANSI/OSC
 * stripping); this adds the corrections it omits — tabs (expanded to
 * `tabWidth` cells), OSC 66 text-sizing payloads (scaled by `s=`), Hangul
 * compatibility jamo, and the zero-width marks it charges cells for.
 */
export function visibleWidth(str: string): number {
	if (!str) return 0;

	// Long non-escape text is faster through Bun's native scanner than through
	// a JS printable-ASCII prepass. Escape-bearing strings stay on the scanner
	// below so CSI/OSC-heavy render output can still bail out at the first ESC.
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

	// `Bun.stringWidth` is a JSC builtin (no per-call N-API number box, unlike
	// the native scanner that traps under Bun 1.3.x GC/N-API load). It strips
	// CSI/OSC to zero cells and shares the native engine's UAX#11 width tables.

	// Strip OSC sequences before measuring: they draw nothing, and an OSC 8
	// hyperlink measured at its escape length rather than its label length is
	// what pushed Markdown table columns out of place (upstream #6282).
	const strippedStr = str.includes(OSC) ? str.replace(OSC_SEQUENCE_REGEX, OSC_STRIP_MARKER) : str;
	let width = correctedBunWidth(strippedStr);

	// Tabs were counted over the RAW string, and the width above came from the
	// stripped one, so every tab that lived INSIDE an OSC sequence was charged a
	// tab stop for text the terminal never draws. A hyperlink whose URL contains a
	// tab, or a window-title OSC, measured three cells wider here than natively.
	// Recount over the text actually measured; only OSC-bearing input pays for it,
	// and that input already paid for the `replace` on the line above.
	if (strippedStr !== str) tabCount = countTabs(strippedStr);

	if (tabCount > 0) width += tabCount * DEFAULT_TAB_WIDTH;

	// OSC 66: add back each stripped span as `scale * (explicit w ?? payload
	// width)`. Matched rather than replaced to avoid reallocating the string.
	if (str.includes(OSC66, i)) {
		OSC66_SPAN_REGEX.lastIndex = 0;
		for (let m = OSC66_SPAN_REGEX.exec(str); m !== null; m = OSC66_SPAN_REGEX.exec(str)) {
			let scale = 1;
			let explicit: number | undefined;
			for (const part of m[1].split(":")) {
				// metadata keys are single chars, e.g. `s=2`, `w=5`
				if (part.indexOf("=") !== 1) continue;
				const value = parseOsc66MetaValue(part.slice(2));
				if (value === undefined) continue;
				if (part[0] === "s") {
					if (value >= 1 && value <= 7) scale = value;
				} else if (part[0] === "w" && value > 0) {
					explicit = value;
				}
			}
			// A tab in the payload scales with the span like everything else in it, so
			// it is counted HERE rather than in the outer pass. Counting it outside was
			// the other half of the tab-scope bug: `s=3` charged one tab stop where the
			// native charged three.
			const payloadWidth = explicit ?? correctedBunWidth(m[2]) + countTabs(m[2]) * DEFAULT_TAB_WIDTH;
			width += scale * payloadWidth;
		}
	}

	return width;
}

const THAI_LAO_AM_GLOBAL_REGEX = /[\u0e33\u0eb3]/g;

/**
 * Normalize text for terminal output without changing logical editor content.
 * Some terminals render precomposed Thai/Lao AM vowels inconsistently during
 * differential repaint. Their compatibility decompositions have the same cell
 * width but avoid stale-cell artifacts in terminal renderers.
 */
export function normalizeTerminalOutput(str: string): string {
	if (str.indexOf("\u0e33") === -1 && str.indexOf("\u0eb3") === -1) return str;
	return str.replace(THAI_LAO_AM_GLOBAL_REGEX, char => (char === "\u0e33" ? "\u0e4d\u0e32" : "\u0ecd\u0eb2"));
}

const makeBoolArray = (chars: string): Uint8Array => {
	const table = new Uint8Array(128);
	for (let i = 0; i < chars.length; i++) {
		const code = chars.charCodeAt(i);
		if (code < table.length) {
			table[code] = 1;
		}
	}
	return table;
};

const ASCII_WHITESPACE = makeBoolArray("\x09\x0a\x0b\x0c\x0d\x20");

/**
 * Check if a character is whitespace.
 */
export function isWhitespaceChar(char: string): boolean {
	const code = char.codePointAt(0) ?? 0;
	return code < 128 && ASCII_WHITESPACE[code] === 1;
}

const ASCII_PUNCTUATION = makeBoolArray("(){}[]<>.,;:'\"!?+-=*/\\|&%^$#@~`");

/**
 * Check if a character is punctuation.
 */
export function isPunctuationChar(char: string): boolean {
	const code = char.codePointAt(0) ?? 0;
	return code < 128 && ASCII_PUNCTUATION[code] === 1;
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

/**
 * Coarse Unicode-aware character classification for word navigation (Option/Alt + Left/Right).
 * This intentionally avoids language-specific word segmentation for predictability across scripts.
 */
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

export function isWordNavJoiner(grapheme: string): boolean {
	const ch = firstCodePointChar(grapheme);
	return WORD_NAV_JOINERS.has(ch);
}

/**
 * Snap a UTF-16 index to the grapheme-cluster boundary at or before it. Callers
 * normally keep the cursor on a boundary, but if one ever lands mid-cluster (a
 * surrogate pair or ZWJ/combining sequence), the word-nav below would slice the
 * string mid-cluster and return another mid-cluster index — a cursor-corruption
 * hazard. Flooring first makes the result unconditionally a boundary; it is a
 * no-op when `cursor` is already one, so valid callers see no behavior change.
 */
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

/**
 * Move the cursor one "word" to the left using Unicode-aware coarse navigation.
 *
 * Returns a new cursor index in the range [0, text.length].
 */
export function moveWordLeft(text: string, cursor: number): number {
	const len = text.length;
	if (len === 0) return 0;
	let i = floorToGraphemeBoundary(text, clamp(cursor, 0, len));
	if (i === 0) return 0;

	const graphemes = [...segmenter.segment(text.slice(0, i))];
	if (graphemes.length === 0) return 0;

	// Skip trailing whitespace.
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
		// Skip word run (letters/numbers/underscore), keeping common joiners inside words.
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

	// Fallback: move by one grapheme.
	i -= graphemes.pop()?.segment.length || 0;
	return Math.max(0, i);
}

/**
 * Move the cursor one "word" to the right using Unicode-aware coarse navigation.
 *
 * Returns a new cursor index in the range [0, text.length].
 */
export function moveWordRight(text: string, cursor: number): number {
	const len = text.length;
	if (len === 0) return 0;
	let i = floorToGraphemeBoundary(text, clamp(cursor, 0, len));
	if (i === len) return len;

	const iterator = segmenter.segment(text.slice(i))[Symbol.iterator]();
	let next = iterator.next();

	// Skip leading whitespace.
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

	// Fallback: move by one grapheme.
	return i + next.value.segment.length;
}

/**
 * Apply background color to a line, padding to full width.
 *
 * @param line - Line of text (may contain ANSI codes)
 * @param width - Total width to pad to
 * @param bgFn - Background color function
 * @returns Line with background applied and padded to width
 */
export function applyBackgroundToLine(line: string, width: number, bgFn: (text: string) => string): string {
	// Calculate padding needed
	const visibleLen = visibleWidth(line);
	const paddingNeeded = Math.max(0, width - visibleLen);

	// Apply background to content + padding
	const withPadding = line + padding(paddingNeeded);
	return bgFn(withPadding);
}

/**
 * Extract a range of visible columns from a line. Handles ANSI codes and wide chars.
 *
 * @param strict - If true, exclude wide chars at boundary that would extend past the range
 */
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
