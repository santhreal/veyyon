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
