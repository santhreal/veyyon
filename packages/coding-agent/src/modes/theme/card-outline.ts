/**
 * The one paint for a card outline, anywhere in the product.
 *
 * WHY THIS IS ITS OWN LEAF. The function was defined in
 * `modes/components/message-frame.ts`, which imports `Markdown` and
 * `getMarkdownTheme` — the whole markdown presentation layer. Every card that
 * wanted an outline colour had to pull that graph in behind it, which is why the
 * floating overlays never used it and grew their own answer instead. It lives
 * here on three leaf imports so `overlay-box.ts` and `modal-shell.ts` can reach
 * it for the price of reaching the theme binding they already reach.
 *
 * WHAT IT PAINTS, and why it is not a theme token. `borderAccent` resolves to
 * `ember` (#F0862E) in titanium, so every overlay frame in the product was
 * drawn in the loudest colour in the palette — on the least informative pixels
 * of the card, with the title beside it in silver. That inverts the hierarchy
 * the frame exists to establish, and it contradicts what `modal-shell.ts` says
 * about itself ("the sun/ember accent … never paints a modal border or fill
 * here") and what `overlay-box.ts` said in the comment above its own paint
 * function ("silver (`borderAccent`)", which `borderAccent` is not).
 *
 * A fixed contrast step off the ground the terminal is ACTUALLY showing is the
 * right answer instead of any static hex: 12% toward the contrast pole reads as
 * the same quiet hairline on a black terminal, a grey one and a light one, where
 * a hex calibrated against near-black either vanishes or turns into a slab. That
 * is the 2026-07-22 regression class, and `theme/ground-tints.ts` is the owner
 * of the derivation.
 *
 * The degrade is loud in behaviour, never a wrong guess: with no OSC 11 report
 * and no painted ground there is no ground to measure from, so the caller gets
 * the static `borderMuted` token, which is the exact pre-detection rendering.
 */

import { type ScrollViewTheme, TERMINAL } from "@veyyon/tui";
import { groundHairlineHex, groundTintFgAnsi } from "./ground-tints";
import { theme } from "./theme-binding";

/**
 * Card-outline paint: a fixed contrast step above the ground that is on screen —
 * the one this process painted, else the one the terminal reported — else the
 * static `borderMuted` token, calibrated for near-black terminals.
 */
export function cardOutlineColor(): (text: string) => string {
	const derived = groundTintFgAnsi(groundHairlineHex(), TERMINAL.trueColor);
	if (derived !== undefined) return text => `${derived}${text}\x1b[39m`;
	return text => theme.fg("borderMuted", text);
}

/**
 * The paint a card's scrollbar takes: {@link cardOutlineColor} for the track, the accent for the
 * thumb.
 *
 * A track is a rule down the inside of the frame, so it is the frame's own hairline; the thumb is
 * the position, which is the one thing on a scrollbar an operator reads, so it keeps the accent.
 *
 * It is a function here because it was a literal in seventeen places. Every overlay that scrolls
 * restated `{ track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) }`, three of them
 * with `dim` instead of `muted`, so the same card's scroll track was one of two weights depending
 * on which file drew it and neither matched the border two columns to its right.
 */
export function cardScrollbarTheme(): Required<ScrollViewTheme> {
	const track = cardOutlineColor();
	return { track, thumb: text => theme.fg("accent", text) };
}
