/**
 * Line wrapping and tab expansion over text that may carry ANSI styling.
 *
 * The wrap itself is the native `wrapTextWithAnsi` binding; this module owns the
 * input normalization it needs and the tab expansion every renderer applies before
 * measuring. No terminal I/O.
 */

import { wrapTextWithAnsi as nativeWrapTextWithAnsi } from "@veyyon/natives";
import { collapseWhitespace } from "./collapse-whitespace";
import { DEFAULT_TAB_WIDTH } from "./tab-spacing";

const TAB_SPACES = " ".repeat(DEFAULT_TAB_WIDTH);

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
