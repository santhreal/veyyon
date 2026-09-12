import { padding } from "@veyyon/utils/padding";
import { applyBackgroundToLine } from "@veyyon/utils/sgr";
import { getSegmenter, visibleWidth } from "@veyyon/utils/width";

/**
 * Return the first grapheme of a string, or an empty string if empty.
 */
export function firstGrapheme(text: string): string {
	const len = text.length;
	if (len === 0) return "";
	if (len === 1) return text;
	const c0 = text.charCodeAt(0);
	if (c0 === 13) {
		return text.charCodeAt(1) === 10 ? "\r\n" : "\r";
	}
	if (c0 < 0x20 || c0 === 0x7f) {
		return text[0]!;
	}
	if (c0 <= 0x7e) {
		const c1 = text.charCodeAt(1);
		if (c1 >= 0x20 && c1 <= 0x7e) {
			return text[0]!;
		}
	}
	for (const seg of getSegmenter().segment(text)) {
		return seg.segment;
	}
	return "";
}

/**
 * Return the last grapheme of a string, or an empty string if empty.
 */
export function lastGrapheme(text: string): string {
	const len = text.length;
	if (len === 0) return "";
	if (len === 1) return text;
	const cLast = text.charCodeAt(len - 1);
	if (cLast === 10 && text.charCodeAt(len - 2) === 13) {
		return "\r\n";
	}
	if (cLast < 0x20 || cLast === 0x7f) {
		return text[len - 1]!;
	}
	const cPrev = text.charCodeAt(len - 2);
	if (cLast <= 0x7e && cPrev >= 0x20 && cPrev <= 0x7e) {
		return text[len - 1]!;
	}
	let tailStart = 0;
	for (let i = len - 1; i > 0; i--) {
		const a = text.charCodeAt(i - 1);
		const b = text.charCodeAt(i);
		if (a >= 0x20 && a <= 0x7e && b >= 0x20 && b <= 0x7e) {
			tailStart = i;
			break;
		}
	}
	const tail = tailStart === 0 ? text : text.slice(tailStart);
	let last = "";
	for (const seg of getSegmenter().segment(tail)) {
		last = seg.segment;
	}
	return last;
}

/**
 * Drop the last code point of a string (stripping a full surrogate pair if trailing).
 */
export function dropLastCodePoint(text: string): string {
	const len = text.length;
	if (len === 0) return "";
	const cut =
		len >= 2 && (text.charCodeAt(len - 1) & 0xfc00) === 0xdc00 && (text.charCodeAt(len - 2) & 0xfc00) === 0xd800
			? 2
			: 1;
	return text.slice(0, len - cut);
}

/**
 * Pad a line to full width and optionally apply a background color function.
 */
export function applyLineBackground(line: string, width: number, bgFn?: (text: string) => string): string {
	if (bgFn) {
		return applyBackgroundToLine(line, width, bgFn);
	}
	const visibleLen = visibleWidth(line);
	const paddingNeeded = Math.max(0, width - visibleLen);
	return line + padding(paddingNeeded);
}
