/**
 * The one paint for a transcript card's outline, and the one shape for a card's
 * scrollbar.
 *
 * WHY THIS IS ITS OWN LEAF. `cardOutlineColor` was defined in
 * `modes/components/message-frame.ts`, which imports `Markdown` and
 * `getMarkdownTheme` — the whole markdown presentation layer. Every card that
 * wanted an outline colour had to pull that graph in behind it. It lives here on
 * leaf imports so a floating overlay can reach it for the price of reaching the
 * theme binding it already reaches.
 *
 * WHICH COLOUR IS NOT THIS MODULE'S DECISION. A palette is chosen in the theme
 * file, so a colour is read from it here and never computed, chosen or
 * substituted. This module owns WHERE a token is spent, never WHICH colour a
 * token is: `cardScrollbarTheme` takes the track token from its caller for
 * exactly that reason, since fourteen surfaces spend `muted` there and three
 * spend `dim`.
 */

import type { ScrollViewTheme } from "@veyyon/tui";
import { TERMINAL } from "@veyyon/tui";
import type { ThemeColor } from "./color";
import { groundHairlineHex, groundTintFgAnsi } from "./ground-tints";
import { theme } from "./theme-binding";

/**
 * Card-outline paint: the OSC 11-derived ground tint when the terminal reported
 * its background (a fixed contrast step above ANY ground), else the static
 * `borderMuted` token, which is calibrated for near-black terminals. One owner
 * for every outlined transcript card.
 */
export function cardOutlineColor(): (text: string) => string {
	const derived = groundTintFgAnsi(groundHairlineHex(), TERMINAL.trueColor);
	if (derived !== undefined) return text => `${derived}${text}\x1b[39m`;
	return text => theme.fg("borderMuted", text);
}

/**
 * The paint a card's scrollbar takes: `track` for the rule, `accent` for the thumb.
 *
 * It is a function here because it was a literal in seventeen places. Every overlay that scrolls
 * restated `{ track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) }`, so the same
 * shape was maintained in seventeen files. `track` carries the token the calling surface has always
 * used — `muted` on fourteen of them, `dim` on the three that read `dim` — because which colour a
 * surface spends is the theme's decision and this pass only removes the duplication.
 */
export function cardScrollbarTheme(track: ThemeColor = "muted"): Required<ScrollViewTheme> {
	return { track: text => theme.fg(track, text), thumb: text => theme.fg("accent", text) };
}
