/**
 * Card geometry for the modal shell: the sizing presets and the card's dimensions and content width on
 * a terminal of a given size.
 *
 * Pure arithmetic with no renderer import, so a tool that pre-wraps text for a card (the `ask` tool's
 * custom input) asks the same question the card answers without loading the terminal renderer. The
 * renderer, and the chrome rows it reserves, are in `modal-shell.ts`.
 */
import { clamp, clampLow } from "@veyyon/utils/math";

/**
 * Columns of padding on EACH side of the hook editor's title and hint rows in the embedded
 * presentation.
 *
 * A caller that pre-wraps or pre-truncates the title has to know the width it will be rendered at;
 * the `ask` tool computes it without loading the editor.
 */
export const HOOK_EDITOR_TEXT_PAD_COLS = 1;

export interface ModalSizing {
	widthPct: number;
	maxWidth: number;
	minWidth: number;
	vMargin: number;
	hPad: number;
	vPad: number;
	/** Reserved rows for the footer shortcut band (grows when chips wrap). */
	footerLines: number;
}

export const MODAL_SIZING_LARGE: ModalSizing = {
	widthPct: 0.9,
	maxWidth: 140,
	minWidth: 60,
	vMargin: 7,
	hPad: 2,
	vPad: 2,
	footerLines: 2,
};

export const MODAL_SIZING_MEDIUM: ModalSizing = {
	widthPct: 0.6,
	maxWidth: 120,
	minWidth: 44,
	vMargin: 4,
	hPad: 2,
	vPad: 1,
	footerLines: 2,
};

// Wider than MEDIUM: the vertical category sidebar consumes ~20 columns.
export const MODAL_SIZING_SETTINGS: ModalSizing = {
	widthPct: 0.8,
	maxWidth: 124,
	minWidth: 44,
	vMargin: 3,
	hPad: 2,
	vPad: 1,
	footerLines: 2,
};

/**
 * Rows a modal keeps even when its margins would take more.
 *
 * 24 because that is the classic terminal height, and it is exactly what the
 * compact path already hands the card. Matching it is what makes the boundary
 * continuous: one row taller than compact must not be a smaller card.
 */
const MODAL_MIN_TALL_ROWS = 24;

/**
 * Whether a card at this height is space-starved and should shed its padding.
 *
 * The old test was `areaHeight <= 24`, read straight off the terminal, and it
 * put a step in the middle of ordinary window sizes: a 24-row terminal gave a
 * full-screen card with no padding, and a 25-row terminal gave a card the same
 * height that spent four of its rows on padding, so growing the window by one
 * row cost four rows of list. The question is not how tall the TERMINAL is. It
 * is whether the card has room to spare, and it does not while its height is
 * still pinned to the floor by {@link MODAL_MIN_TALL_ROWS}.
 */
export function modalNeedsCompactPadding(areaHeight: number, sizing: ModalSizing): boolean {
	return areaHeight - 2 * sizing.vMargin <= MODAL_MIN_TALL_ROWS;
}

/**
 * The sizing a card should actually use in an area this tall.
 *
 * This is the ONLY way to reach the compact strip, and it takes the AREA HEIGHT
 * rather than a decision, because every hand-rolled decision this replaced was
 * wrong in the same direction. `ModelPicker` carried `termRows < 24` and so kept
 * its padding for every height from 24 to 32, where {@link modalNeedsCompactPadding}
 * says the card is still pinned to its floor: the card grew four rows at 33 and
 * the list lost them, which is precisely the cliff the shared rule exists to
 * remove. A threshold read off the terminal cannot be right for more than one
 * sizing, since the answer depends on that sizing's own margins.
 *
 * `forceCompact` can only make a card compact EARLIER than the height rule would.
 * It exists for a card whose own mode already denies it the room (the session
 * selector when it is not filling the height), and because the height rule is
 * always applied underneath it, no caller can push the boundary later and bring
 * the cliff back.
 *
 * The strip sheds padding and nothing else. It used to zero `vMargin` too, which
 * is what made leaving compact mode a cliff rather than a step: a compact card
 * took the WHOLE screen, so the first height that stopped being compact dropped
 * it by two full margins at once (14 rows for LARGE) and the list lost more than
 * half its rows. The margin is now handled continuously by the floor in
 * {@link computeModalDims}, which already gives a short terminal its whole screen.
 */
export function sizingForArea(sizing: ModalSizing, areaHeight: number, forceCompact = false): ModalSizing {
	if (!forceCompact && !modalNeedsCompactPadding(areaHeight, sizing)) return sizing;
	return { ...sizing, hPad: 1, vPad: 0 };
}

export interface ModalDims {
	modalWidth: number;
	modalHeight: number;
	leftPad: number;
	topPad: number;
	/** Inner content width (between vertical borders and one-space insets). */
	contentWidth: number;
}

/**
 * Compute floating popup geometry. Returns null when the area is too small
 * to paint meaningful chrome (Grok abort gate: w<20 or h<6).
 */
export function computeModalDims(areaWidth: number, areaHeight: number, sizing: ModalSizing): ModalDims | null {
	const maxWidth = clamp(areaWidth - 4, 0, sizing.maxWidth);
	const preferred = Math.floor(areaWidth * sizing.widthPct);
	const modalWidth = Math.min(areaWidth, clampLow(preferred, sizing.minWidth, maxWidth));
	// A margin is breathing room, never a squeeze. Subtracting `vMargin` from both
	// ends unconditionally made the card SHRINK as the terminal grew: at 24 rows
	// the compact path takes the whole screen, and at 25 rows the full LARGE margin
	// (7 each end) left an 11-row card whose body had no room for a single list row
	// at all. Opening a list surface on a 25-to-30-row terminal, which is an
	// ordinary split pane, showed an empty box. The floor keeps the card at
	// MODAL_MIN_TALL_ROWS (or the whole screen when the screen is smaller than
	// that), so height is monotonic in terminal height and the compact boundary is
	// a step of zero rows instead of thirteen.
	// The floor rises with the padding the card carries. A card that sheds its
	// padding (the compact path) needs only the base floor; one that pays for
	// padding is given four rows of height per row of padding BEFORE it starts
	// paying, so switching the padding on can never cost the body a row. Without
	// that, the body dropped three rows at the one height where padding came back.
	const floorRows = Math.min(areaHeight, MODAL_MIN_TALL_ROWS + 4 * sizing.vPad);
	const modalHeight = Math.max(areaHeight - 2 * sizing.vMargin, floorRows);
	if (modalWidth < 20 || modalHeight < 6) return null;
	const leftPad = Math.max(0, Math.floor((areaWidth - modalWidth) / 2));
	const topPad = Math.max(0, Math.floor((areaHeight - modalHeight) / 2));
	const contentWidth = Math.max(1, modalWidth - 2 - 2 * Math.max(1, sizing.hPad));
	return { modalWidth, modalHeight, leftPad, topPad, contentWidth };
}

/**
 * The card width whose CONTENT row is `contentWidth` cells wide — the inverse of the
 * `contentWidth` {@link computeModalDims} returns. A caller that knows how wide its widest row
 * has to be raises `minWidth` to this instead of restating the border-and-padding arithmetic.
 */
export function modalWidthForContent(contentWidth: number, sizing: ModalSizing): number {
	return contentWidth + 2 + 2 * Math.max(1, sizing.hPad);
}

/**
 * How many cells a medium card's content row gets on a terminal this size, or null when the
 * terminal is too small for a card at all. It exists so a caller that has to pre-wrap text for a
 * medium card asks the layout owner one question instead of assembling `sizingForArea` and
 * {@link computeModalDims} itself: the sizing a medium card uses is this module's decision, and a
 * second copy of it wraps to a width the card then wraps again.
 */
export function mediumModalContentWidth(areaWidth: number, areaHeight: number): number | null {
	const dims = computeModalDims(areaWidth, areaHeight, sizingForArea(MODAL_SIZING_MEDIUM, areaHeight));
	return dims ? dims.contentWidth : null;
}
