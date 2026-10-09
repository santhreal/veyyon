/**
 * Unicode-aware coarse word navigation for a text cursor (Option/Alt + arrow).
 *
 * Deliberately not language-specific word segmentation: predictability across
 * scripts beats correctness in any one of them. No terminal I/O.
 */

import { clamp } from "./math";
import { getSegmenter } from "./width";

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
	for (const { segment } of getSegmenter().segment(text)) {
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
	const start = floorToGraphemeBoundary(text, clamp(cursor, 0, len));
	if (start === 0) return 0;

	const graphemes = [...getSegmenter().segment(text.slice(0, start))];
	// Skip trailing whitespace.
	const end = runStartLeft(graphemes, graphemes.length, "whitespace");
	if (end === 0) return 0;

	const kind = getWordNavKind(graphemes[end - 1].segment);
	// Fallback: move by one grapheme.
	let to = end - 1;
	if (kind === "delimiter" || kind === "cjk") to = runStartLeft(graphemes, end, kind);
	else if (kind === "word") to = wordStartLeft(graphemes, end);
	return graphemes[to].index;
}

/** Index of the first grapheme in the run of `kind` that ends before grapheme `end`. */
function runStartLeft(graphemes: readonly Intl.SegmentData[], end: number, kind: WordNavKind): number {
	let n = end;
	while (n > 0 && getWordNavKind(graphemes[n - 1].segment) === kind) n--;
	return n;
}

/**
 * Index of the first grapheme in the word run that ends before grapheme `end`, a `word` grapheme:
 * letters, numbers and underscores, and a joiner with a word grapheme on each side.
 */
function wordStartLeft(graphemes: readonly Intl.SegmentData[], end: number): number {
	let n = end;
	while (n > 0) {
		const segment = graphemes[n - 1].segment;
		const kind = getWordNavKind(segment);
		if (kind !== "word") {
			// A joiner (`'`, `-`, ...) stays in the word only with a word grapheme on its left too.
			const joined =
				kind === "delimiter" &&
				isWordNavJoiner(segment) &&
				n > 1 &&
				getWordNavKind(graphemes[n - 2].segment) === "word";
			if (!joined) break;
		}
		n--;
	}
	return n;
}

/**
 * Move the cursor one "word" to the right using Unicode-aware coarse navigation.
 *
 * Returns a new cursor index in the range [0, text.length].
 */
export function moveWordRight(text: string, cursor: number): number {
	const len = text.length;
	if (len === 0) return 0;
	const start = floorToGraphemeBoundary(text, clamp(cursor, 0, len));
	if (start === len) return len;

	// Graphemes are read lazily: a move reads only up to the end of the next word.
	const graphemes = getSegmenter().segment(text.slice(start))[Symbol.iterator]();
	// Skip leading whitespace.
	const first = skipRunRight(graphemes.next(), graphemes, "whitespace");
	if (first.done) return len;

	const kind = getWordNavKind(first.value.segment);
	let stop: IteratorResult<Intl.SegmentData>;
	if (kind === "delimiter" || kind === "cjk") stop = skipRunRight(first, graphemes, kind);
	else if (kind === "word") stop = skipWordRight(first, graphemes);
	// Fallback: move by one grapheme.
	else return start + first.value.index + first.value.segment.length;
	return stop.done ? len : start + stop.value.index;
}

/** The first grapheme from `from` on that is not of `kind`. */
function skipRunRight(
	from: IteratorResult<Intl.SegmentData>,
	graphemes: Iterator<Intl.SegmentData>,
	kind: WordNavKind,
): IteratorResult<Intl.SegmentData> {
	let step = from;
	while (!step.done && getWordNavKind(step.value.segment) === kind) step = graphemes.next();
	return step;
}

/**
 * The first grapheme past the word run that starts at `from`, a `word` grapheme: letters, numbers
 * and underscores, and a joiner with a word grapheme on each side.
 */
function skipWordRight(
	from: IteratorResult<Intl.SegmentData>,
	graphemes: Iterator<Intl.SegmentData>,
): IteratorResult<Intl.SegmentData> {
	let step = from;
	while (!step.done) {
		const segment = step.value.segment;
		const kind = getWordNavKind(segment);
		if (kind === "word") {
			step = graphemes.next();
			continue;
		}
		// A joiner (`'`, `-`, ...) stays in the word only with a word grapheme on its right too.
		if (kind !== "delimiter" || !isWordNavJoiner(segment)) return step;
		const lookahead = graphemes.next();
		if (lookahead.done || getWordNavKind(lookahead.value.segment) !== "word") return step;
		step = lookahead;
	}
	return step;
}
