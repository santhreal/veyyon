/**
 * Line budgets and notice prefixes the file, text and structure search cards share with the tools
 * that write the output they draw. A leaf on purpose: a card imports these without the tool behind
 * it, so a host that draws a transcript never loads the searcher, the web manifest or the internal
 * URL router it reaches, or the session runtime past that.
 */

import { PREVIEW_LIMITS } from "../core/render-limits";

/** Files a collapsed file-search card lists before it states how many it held back. */
export const COLLAPSED_LIST_LIMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;

/**
 * Opening words of the match-limit notice. The card's group filter matches this prefix to keep the
 * notice out of the code-frame groups, so both sites read one definition rather than two copies of
 * the same words.
 */
export const MATCH_LIMIT_NOTICE_PREFIX = "Match limit reached";

export const COLLAPSED_MATCH_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;

export const COLLAPSED_TEXT_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;
/** Line budget for the expanded view. Larger than collapsed so expanding
 * reveals more matches with context, but still bounded so a single hot file
 * whose matches span the whole file can't dump its entire length. */
export const EXPANDED_TEXT_LIMIT = PREVIEW_LIMITS.EXPANDED_LINES * 2;

/** A body row the search itself marked as the match, rather than the lines around it. */
const MARKED_MATCH_RE = /^\s*\*\d+(?:│|[:|])/;

/** A grouped-output header, which is the row that names the file or directory under it. */
const HEADER_RE = /^#+ /;

export function isMarkedMatch(raw: string): boolean {
	return MARKED_MATCH_RE.test(raw);
}

export function isHeader(raw: string): boolean {
	return HEADER_RE.test(raw);
}

/** The rows of a text search's card body a card can draw, and the marked matches past them. */
export interface CardDisplayRows {
	rows: readonly string[];
	heldMatches: number;
}

/**
 * The leading rows of a text search's card body that a card draws in either view, and how many
 * marked matches follow them.
 *
 * The card draws at most {@link EXPANDED_TEXT_LIMIT} rows expanded and {@link COLLAPSED_TEXT_LIMIT}
 * header and match rows collapsed, taken from the front of the body, so the rows kept end at the
 * first row that reaches both budgets. A group cut there still compacts to the front of what it
 * compacts to whole: a grouped body opens every group with its header, and a single-file body has
 * its counted match rows before the cut. The rows past it are never drawn: the card adds
 * `heldMatches` to its held-back count instead. A body with no marked match past the cut is returned
 * whole, because the card counts the context rows it holds back when no match is held.
 */
export function cardDisplayRows(lines: readonly string[]): CardDisplayRows {
	let rows = 0;
	let compactRows = 0;
	let end = -1;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		if (line.trim().length === 0) continue;
		rows++;
		if (isMarkedMatch(line) || isHeader(line)) compactRows++;
		if (rows >= EXPANDED_TEXT_LIMIT && compactRows >= COLLAPSED_TEXT_LIMIT) {
			end = index + 1;
			break;
		}
	}
	if (end === -1) return { rows: lines, heldMatches: 0 };
	let heldMatches = 0;
	for (let index = end; index < lines.length; index++) if (isMarkedMatch(lines[index]!)) heldMatches++;
	return heldMatches === 0 ? { rows: lines, heldMatches: 0 } : { rows: lines.slice(0, end), heldMatches };
}
