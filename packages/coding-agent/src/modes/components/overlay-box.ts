/**
 * Shared box-drawing chrome for floating overlays. Rounded {@link cardBox}
 * glyphs painted as a hairline a fixed contrast step off the ground the
 * terminal is showing, with the title in `accent` above it.
 *
 * The frame used to be `borderAccent`, described in the comment below as
 * "silver". It is not: `borderAccent` resolves to `ember` (#F0862E) in titanium,
 * so every card in the product was outlined in the loudest colour in the palette
 * while its title sat beside it in silver — the hierarchy a frame exists to
 * establish, inverted, on every overlay. `modal-shell.ts` states the rule the
 * product was breaking: the sun/ember accent is reserved for the caret, the
 * focus ring and links, and never paints a modal border.
 *
 * `cardOutlineColor()` is the same paint the outlined transcript cards use, so
 * there is one answer to "what colour is a card edge" instead of two.
 */
import { padding, TERMINAL, truncateToWidth, visibleWidth } from "@veyyon/tui";
import { cardOutlineColor } from "../theme/card-outline";
import { getVisibleGround } from "../theme/ground-tints";
import { theme } from "../theme/theme";

/**
 * The box style every floating card is drawn in.
 *
 * Rounded, and in one place, because "what shape is a card" is a question two
 * modules answer: this one draws the borders and rows, `modal-shell.ts` draws the
 * title row with its close chip. Both read `theme.boxSharp` before, so a card's
 * top-left corner and its bottom-left corner were separate decisions that
 * happened to agree. `boxRound` sources its junction glyphs from the sharp
 * tokens, so a theme overriding a tee keeps that override here.
 */
export function cardBox() {
	return theme.boxRound;
}

/** Pad or truncate a (possibly ANSI-styled) string to exactly `width` columns. */
export function fit(text: string, width: number): string {
	if (width <= 0) return "";
	const w = visibleWidth(text);
	if (w === width) return text;
	if (w < width) return text + padding(width - w);
	const cut = truncateToWidth(text, width);
	const cw = visibleWidth(cut);
	return cw < width ? cut + padding(width - cw) : cut;
}

/**
 * Structural chrome — a hairline off the visible ground, never the ember accent.
 *
 * The painter is resolved once per ground rather than once per glyph run. `row()`
 * paints two verticals for every body row, so a 40-row card asks for this ~80
 * times a frame, and `cardOutlineColor()` walks the ground hex, takes its luma,
 * lerps three channels and formats an SGR on each call.
 *
 * Both inputs the paint depends on are in the key. The ground changes on an OSC
 * 11 report, a theme switch or a ground repaint; `TERMINAL.trueColor` is a
 * probe-driven flag that can still flip after the first frame, and it decides
 * whether the derived tint is used at all. The static fallback reads
 * `theme.fg("borderMuted")` inside the closure, so it follows a theme switch on
 * its own without being part of the key.
 */
let outlinePainter: ((text: string) => string) | undefined;
let outlinePainterGround: string | undefined;
let outlinePainterTrueColor: boolean | undefined;

function paint(s: string): string {
	const ground = getVisibleGround();
	if (
		outlinePainter === undefined ||
		outlinePainterGround !== ground ||
		outlinePainterTrueColor !== TERMINAL.trueColor
	) {
		outlinePainterGround = ground;
		outlinePainterTrueColor = TERMINAL.trueColor;
		outlinePainter = cardOutlineColor();
	}
	return outlinePainter(s);
}

/** Top border with an optional accent-colored title inset into the rule. */
export function topBorder(width: number, title: string): string {
	const box = cardBox();
	const inner = Math.max(0, width - 2);
	if (!title) return paint(box.topLeft + box.horizontal.repeat(inner) + box.topRight);
	const shown = truncateToWidth(` ${title} `, Math.max(0, inner - 2));
	const fillWidth = Math.max(0, inner - 1 - visibleWidth(shown));
	return (
		paint(box.topLeft + box.horizontal) +
		theme.bold(theme.fg("accent", shown)) +
		paint(box.horizontal.repeat(fillWidth) + box.topRight)
	);
}

/**
 * A section rule, inset between the card's own verticals.
 *
 * It used to weld a `├` and a `┤` into the frame. Two tees on a card that holds
 * three or four sections cut the surface into stacked boxes: the eye reads each
 * band as its own container, and the frame stops being one edge. Inset, the rule
 * separates the bands and the frame stays a single line around all of them.
 */
export function divider(width: number): string {
	const box = cardBox();
	const rule = box.horizontal.repeat(Math.max(0, width - 4));
	return `${paint(box.vertical)} ${paint(rule)} ${paint(box.vertical)}`;
}

export function bottomBorder(width: number): string {
	const box = cardBox();
	return paint(box.bottomLeft + box.horizontal.repeat(Math.max(0, width - 2)) + box.bottomRight);
}

/** Wrap pre-styled content in vertical borders with single-column insets. */
export function row(content: string, width: number): string {
	const box = cardBox();
	return `${paint(box.vertical)} ${fit(content, Math.max(0, width - 4))} ${paint(box.vertical)}`;
}

/**
 * Column index (0-based) of the inner divider for a two-column layout whose
 * sidebar content area is `sidebarWidth` columns wide. The layout is
 * `│ sidebar │ body │` with a single-column inset on every side, so the divider
 * vertical sits at `sidebarWidth + 3` and the body content area is
 * {@link splitBodyWidth} columns.
 */
function splitDividerCol(sidebarWidth: number): number {
	return sidebarWidth + 3;
}

/** Body content width for a two-column overlay of total `width`. */
export function splitBodyWidth(width: number, sidebarWidth: number): number {
	return Math.max(0, width - sidebarWidth - 7);
}

/** Top border carrying the title, split by a `┬` over the column divider. */
export function topBorderSplit(width: number, title: string, sidebarWidth: number): string {
	const box = cardBox();
	const dividerCol = splitDividerCol(sidebarWidth);
	const leftLen = Math.max(0, dividerCol - 1);
	const rightLen = Math.max(0, width - 2 - dividerCol);
	let left: string;
	if (!title) {
		left = paint(box.topLeft + box.horizontal.repeat(leftLen));
	} else {
		const shown = truncateToWidth(` ${title} `, Math.max(0, leftLen - 1));
		const fillWidth = Math.max(0, leftLen - 1 - visibleWidth(shown));
		left =
			paint(box.topLeft + box.horizontal) +
			theme.bold(theme.fg("accent", shown)) +
			paint(box.horizontal.repeat(fillWidth));
	}
	return left + paint(box.teeDown + box.horizontal.repeat(rightLen) + box.topRight);
}

/** Section rule that closes the sidebar column with a `┴` over the divider. */
export function dividerSplit(width: number, sidebarWidth: number): string {
	const box = cardBox();
	const dividerCol = splitDividerCol(sidebarWidth);
	const leftLen = Math.max(0, dividerCol - 1);
	const rightLen = Math.max(0, width - 2 - dividerCol);
	const left = box.horizontal.repeat(Math.max(0, leftLen - 1));
	const right = box.horizontal.repeat(Math.max(0, rightLen - 1));
	return `${paint(box.vertical)} ${paint(left + box.teeUp + right)} ${paint(box.vertical)}`;
}

/** A two-column content row: `│ sidebar │ body │`, each inset by one column. */
export function splitRow(sidebar: string, body: string, width: number, sidebarWidth: number): string {
	const box = cardBox();
	const bodyWidth = splitBodyWidth(width, sidebarWidth);
	const bar = paint(box.vertical);
	return `${bar} ${fit(sidebar, sidebarWidth)} ${bar} ${fit(body, bodyWidth)} ${bar}`;
}
