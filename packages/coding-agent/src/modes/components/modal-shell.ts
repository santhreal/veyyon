/**
 * ModalShell — shared floating overlay chrome for Veyyon TUI surfaces.
 *
 * Structure mirrors Grok Build's ModalWindow (sizing, title border, tip gap,
 * centered shortcut footer, content inset math, fold glyphs, chrome mouse).
 * Brand: silver is the structural chrome — border, title, footer chips, fold
 * glyphs. The sun/ember accent is rare and reserved for the caret, focus
 * ring, and links elsewhere in the product; it never paints a modal border
 * or fill here. Sharp box-drawing only, no rounded corners.
 *
 * Product constraint: Veyyon stays transcript + composer; overlays float on
 * top. This is not a full-screen TUI conversion.
 */
import {
	type Animation,
	type ColumnWindow,
	cascadeStrength,
	clamp,
	clampLow,
	fadeLineTowards,
	fillSurface,
	type Keybinding,
	liftHex,
	MOTION,
	type MotionClock,
	motionClock,
	padding,
	paintLineBackground,
	type SurfaceBand,
	sweepSurface,
	TERMINAL,
	truncateToWidth,
	visibleWidth,
} from "@veyyon/tui";
import { getVisibleGround } from "../theme/ground-tints";
import { transitionsEnabled } from "../theme/shimmer";
import { theme, visibleGroundHex } from "../theme/theme";
import { actionKeyHint } from "../utils/key-hint";
import { emberTick } from "./composer-chrome";
import { bottomBorder, divider, fit, row, topBorder } from "./overlay-box";

/** Leading decoration width before the title text on the top border. */
export const TITLE_LEADING_DECORATION_W = 2;

/** Fold indicator always occupies two columns (Grok FoldInfo parity). */
export const FOLD_COLS = 2;

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
 * Rows {@link renderModalShell} reserves outside the body when nothing is
 * droppable: the top border, the caller's vertical padding ABOVE AND BELOW the
 * body, the footer divider, the reserved footer band, and the bottom border.
 *
 * A caller that decides its own layout before rendering (side-by-side preview
 * versus stacked, say) needs the body budget, and the only alternative to this is
 * to restate the arithmetic. `ask-dialog.ts` did restate it, as
 * `3 + footerLines + vPad`, with a comment admitting it "mirrors the arithmetic
 * renderModalShell uses internally". That is the same number by coincidence of
 * three unnamed `1`s, and nothing would have failed if the shell had grown a row.
 * The terms live here now, next to the loop that shrinks them.
 *
 * This is the MINIMUM. The real reservation grows with a search line (two more
 * rows) and with shortcut chips that wrap past `footerLines`, and shrinks again
 * when the card is too short: the tip gap goes, then the tip, then `vPad`, then
 * the caller's reserved footer padding down to the chip rows. A caller sizing a
 * layout wants the floor, which is what this returns.
 */
export function minModalChromeRows(sizing: ModalSizing): number {
	const topBorder = 1;
	const footerDivider = 1;
	const bottomBorder = 1;
	return topBorder + 2 * sizing.vPad + footerDivider + sizing.footerLines + bottomBorder;
}

/** What {@link renderModalShell} will reserve outside the body for a given card. */
export interface ModalChromePlan {
	/** Laid-out shortcut chip rows (already wrapped to `contentWidth`). */
	layoutRows: ShortcutLayoutRow[];
	tipText: string;
	searchChrome: number;
	/** Padding rows, charged once ABOVE and once BELOW the body. */
	vPad: number;
	tipRows: number;
	tipGap: number;
	footerBand: number;
	/** Every row that is not body: borders, padding, divider, footer band. */
	nonBody: number;
	/** Body rows the card can actually show. Content past this is dropped. */
	maxBodyRows: number;
}

/**
 * Resolve the chrome reservation for one card, including the shrink order that
 * applies when it is too short.
 *
 * {@link minModalChromeRows} answers the static question (what does this sizing
 * cost at minimum). This answers the real one: given these shortcuts, this tip,
 * and this height, how many body rows will the card show? A caller that builds
 * its body before rendering needs that number, because the shell SILENTLY
 * TRUNCATES a body that is too long — `input.body.slice(0, bodyBudget)`.
 *
 * `model-hub.ts` learned that the hard way. It sized its split pane against a
 * restated `3 + footerLines + vPad`, which charges `vPad` once where the card
 * charges it twice, so its body ran two rows long and the shell silently ate the
 * tail. The tail was the hub's strip row, which carries the hint line and every
 * chip strip, so the entire contextual surface of the model hub was missing on
 * an ordinary 40-row terminal. There must be ONE answer to "how many rows do I
 * get", and this is it.
 */
export function planModalChrome(input: {
	sizing: ModalSizing;
	modalHeight: number;
	contentWidth: number;
	shortcuts: readonly ModalShortcut[];
	hoveredShortcutId?: string | null;
	tipCandidates?: readonly string[];
	hasSearch?: boolean;
}): ModalChromePlan {
	const { sizing, modalHeight, contentWidth } = input;
	const layoutRows = layoutShortcutRows(input.shortcuts, contentWidth, input.hoveredShortcutId);
	const tipText = input.tipCandidates?.length ? fitTipLine(input.tipCandidates, contentWidth) : "";
	const searchChrome = input.hasSearch ? 2 : 0;

	// Chips (or the caller's reserved footer lines) plus the top border, footer
	// divider, and bottom border are mandatory chrome — they must never be
	// clipped. The tip line, its gap, and the vertical padding are droppable, in
	// that order, when the card is too short (e.g. a search+tip overlay on a
	// 24-row terminal, where a naive slice would shear off the bottom border).
	const shortcutRows = layoutRows.length;
	let vPad = sizing.vPad;
	let tipRows = tipText ? 1 : 0;
	let tipGap = tipRows > 0 && modalHeight >= 6 ? 1 : 0;
	let footerBand = Math.max(sizing.footerLines, shortcutRows + tipRows + tipGap);
	// vPad is charged TWICE: the body gets the same breathing room above and
	// below. A single top pad was invisible while every card was full height and
	// padded with filler rows, but a card that hugs its content shows the last
	// row resting directly on the footer divider.
	const nonBody = () => 1 + searchChrome + 2 * vPad + 1 + footerBand + 1;
	const refreshFooterBand = () => {
		footerBand = Math.max(sizing.footerLines, shortcutRows + tipRows + tipGap);
	};
	if (nonBody() > modalHeight && tipGap > 0) {
		tipGap = 0;
		refreshFooterBand();
	}
	if (nonBody() > modalHeight && tipRows > 0) {
		tipRows = 0;
		refreshFooterBand();
	}
	while (nonBody() > modalHeight && vPad > 0) vPad--;
	// Last resort: give up the caller's reserved footer padding, but keep every
	// shortcut chip row.
	while (nonBody() > modalHeight && footerBand > shortcutRows) footerBand--;

	return {
		layoutRows,
		tipText,
		searchChrome,
		vPad,
		tipRows,
		tipGap,
		footerBand,
		nonBody: nonBody(),
		maxBodyRows: Math.max(0, modalHeight - nonBody()),
	};
}

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

/** The close chip on a card's title row, and the one place its cells are counted. */
const MODAL_CLOSE_CHIP = " [x] ";

/**
 * The card width whose CONTENT row is `contentWidth` cells wide — the inverse of the
 * `contentWidth` {@link computeModalDims} returns. A caller that knows how wide its widest row
 * has to be raises `minWidth` to this instead of restating the border-and-padding arithmetic.
 */
export function modalWidthForContent(contentWidth: number, sizing: ModalSizing): number {
	return contentWidth + 2 + 2 * Math.max(1, sizing.hPad);
}

/**
 * The card width whose TITLE row shows `titleWidth` cells without an ellipsis. The title row is
 * not the content row: it pays for the two borders, the ember tick that replaces the leading
 * rule, a space each side of the title, and the close chip. A card sized only by
 * {@link modalWidthForContent} cuts the last word off its own title, which is how a credential
 * prompt lost the sentence that told the operator a name comes later.
 */
export function modalWidthForTitle(titleWidth: number): number {
	return titleWidth + 2 + 2 + 2 + visibleWidth(MODAL_CLOSE_CHIP);
}

/** One footer chip. `clickable` marks action vs inert hint (mouse targets). */
export interface ModalShortcut {
	/** Display text. When `keybindings` is present, the live bound keys are prepended at render time. */
	label: string;
	/** Actions that trigger this shortcut. Unbound actions are omitted; an entirely unbound chip disappears. */
	keybindings?: readonly Keybinding[];
	clickable?: boolean;
	id?: string;
}

/** Screen-space hit rect for a clickable footer chip. */
export interface ShortcutHitRect {
	id: string;
	row: number;
	colStart: number;
	colEnd: number;
}

// One separator grammar across the whole TUI: the middle dot, two spaces each
// side. The composer status line, welcome hints, and every ceremony footer use
// `·`; modal footers used to be the lone `|` holdout, which read as a different
// dialect on the same screen. Same visible width (5 cells), so chip layout math
// is unchanged.
const SHORTCUT_SEP = "  ·  ";

function styleShortcutChip(label: string, hovered: boolean): string {
	const space = label.indexOf(" ");
	const key = space === -1 ? label : label.slice(0, space);
	const rest = space === -1 ? "" : label.slice(space);
	// Keys are bright silver (structure); labels stay muted. Hover keeps silver
	// weight — never promote sun/ember into the chip band.
	const keyStyled = theme.bold(theme.fg("accent", key));
	const restStyled = rest ? theme.fg(hovered ? "muted" : "dim", rest) : "";
	const chip = `${keyStyled}${restStyled}`;
	return hovered ? theme.bg("selectedBg", chip) : chip;
}

export interface ShortcutLayoutRow {
	plain: string;
	styled: string;
	/** Chip placements within the content column (before centering pad). */
	chips: { id?: string; clickable: boolean; offset: number; width: number }[];
}

/** Chip labels with live keybindings resolved. A chip whose every action is unbound disappears. */
function resolveShortcutLabels(shortcuts: readonly ModalShortcut[]): ModalShortcut[] {
	const resolved: ModalShortcut[] = [];
	for (const shortcut of shortcuts) {
		if (!shortcut.keybindings) {
			resolved.push(shortcut);
			continue;
		}
		const keys = shortcut.keybindings.map(actionKeyHint).filter(Boolean);
		if (keys.length === 0) continue;
		resolved.push({ ...shortcut, label: `${keys.join("/")} ${shortcut.label}` });
	}
	return resolved;
}

/**
 * Greedy forward pack of chip widths into rows, in the order given.
 *
 * ONE OWNER FOR THE PACKING RULE, because two callers ask about it: the renderer, which needs the
 * rows, and {@link shortcutBandWidth}, which needs only how many there would be at a candidate
 * width. A second copy of this loop would let a card size itself against a packing its own footer
 * does not perform, which paints a row of chips the card is one column too narrow to hold.
 *
 * Greedy is optimal for the row COUNT, since the chips cannot be reordered, but it can strand a
 * lone trailing chip whose row-mates all landed on the row above; the caller that renders fixes
 * that by borrowing backwards, which never changes the count.
 */
function packChipRows(widths: readonly number[], width: number, sepW: number): number[][] {
	const groups: number[][] = [];
	let current: number[] = [];
	let currentW = 0;
	for (let i = 0; i < widths.length; i++) {
		const w = widths[i]!;
		const extra = current.length === 0 ? w : sepW + w;
		if (current.length > 0 && currentW + extra > width) {
			groups.push(current);
			current = [i];
			currentW = w;
		} else {
			current.push(i);
			currentW += extra;
		}
	}
	if (current.length > 0) groups.push(current);
	return groups;
}

export function layoutShortcutRows(
	shortcuts: readonly ModalShortcut[],
	width: number,
	hoveredId?: string | null,
): ShortcutLayoutRow[] {
	if (width <= 0 || shortcuts.length === 0) return [];
	const resolvedShortcuts = resolveShortcutLabels(shortcuts);
	const chips = resolvedShortcuts.map(s => ({
		id: s.id,
		clickable: Boolean(s.clickable && s.id),
		plain: s.label,
		styled: styleShortcutChip(s.label, Boolean(s.id && s.id === hoveredId)),
		w: visibleWidth(s.label),
	}));
	const sepW = visibleWidth(SHORTCUT_SEP);
	const groups = packChipRows(
		chips.map(c => c.w),
		width,
		sepW,
	);

	const groupWidth = (indices: number[]): number =>
		indices.reduce((w, idx, pos) => w + chips[idx]!.w + (pos > 0 ? sepW : 0), 0);

	// Orphan-avoidance pass: borrow chips backward from the previous row's
	// tail so no row ends up alone beneath a fuller one above it. A donor row
	// may give up its last chip as long as it keeps at least one for itself —
	// no special-casing of row 0 needed: sweeping right-to-left means a row
	// drained down to 1 while donating is re-examined (and refilled from its
	// own predecessor) on the very next iteration, so a deficiency cascades
	// as far back as width allows.
	for (let i = groups.length - 1; i > 0; i--) {
		while (groups[i]!.length < 2 && groups[i - 1]!.length > 1) {
			const prev = groups[i - 1]!;
			const movedIdx = prev[prev.length - 1]!;
			const existingWidth = groupWidth(groups[i]!);
			const candidateWidth = chips[movedIdx]!.w + (groups[i]!.length > 0 ? sepW + existingWidth : 0);
			if (candidateWidth > width) break;
			prev.pop();
			groups[i]!.unshift(movedIdx);
		}
	}

	return groups.map(indices => {
		let plain = "";
		let styled = "";
		let w = 0;
		const rowChips: ShortcutLayoutRow["chips"] = [];
		for (const idx of indices) {
			const chip = chips[idx]!;
			if (w === 0) {
				plain = chip.plain;
				styled = chip.styled;
				rowChips.push({ id: chip.id, clickable: chip.clickable, offset: 0, width: chip.w });
				w = chip.w;
			} else {
				const offset = w + sepW;
				plain += SHORTCUT_SEP + chip.plain;
				styled += theme.fg("dim", SHORTCUT_SEP) + chip.styled;
				w += sepW + chip.w;
				rowChips.push({ id: chip.id, clickable: chip.clickable, offset, width: chip.w });
			}
		}
		return { plain, styled, chips: rowChips };
	});
}

/**
 * Greedy wrap of centered shortcut chips. Returns ANSI-styled lines.
 */
export function renderModalShortcuts(
	shortcuts: readonly ModalShortcut[],
	width: number,
	hoveredId?: string | null,
): string[] {
	return layoutShortcutRows(shortcuts, width, hoveredId).map(({ plain, styled }) => {
		const pad = Math.max(0, width - visibleWidth(plain));
		const left = Math.floor(pad / 2);
		return padding(left) + styled + padding(pad - left);
	});
}

/** First tip candidate that fits; else truncate the last. */
export function fitTipLine(candidates: readonly string[], width: number): string {
	if (width <= 0 || candidates.length === 0) return "";
	for (const c of candidates) {
		if (visibleWidth(c) <= width) return c;
	}
	return truncateToWidth(candidates[candidates.length - 1] ?? "", width);
}

/** Collapsed fold glyph + trailing space (always {@link FOLD_COLS} columns). */
export function foldCollapsedGlyph(hovered = false): string {
	const g = `${theme.nav.expand} `;
	return hovered ? theme.bold(theme.fg("accent", g)) : theme.fg("dim", g);
}

/** Expanded fold glyph + trailing space (always {@link FOLD_COLS} columns). */
export function foldExpandedGlyph(hovered = false): string {
	const g = `${theme.nav.collapse} `;
	return hovered ? theme.bold(theme.fg("accent", g)) : theme.fg("dim", g);
}

export interface ModalShellInput {
	title: string;
	/** Breadcrumb suffix shown after title, e.g. " › Theme". */
	breadcrumb?: string;
	/**
	 * When true (and {@link breadcrumb} is set), style the whole title as an
	 * underlined click target and hit-test it as `{ kind: "breadcrumb" }`
	 * (peel one sub-pane level back to Browse). Mirrors Grok's clickable
	 * `settings_breadcrumb_rect`.
	 */
	breadcrumbClickable?: boolean;
	/** Hover state for the clickable breadcrumb title (brighter fg). */
	breadcrumbHovered?: boolean;
	sizing: ModalSizing;
	areaWidth: number;
	areaHeight: number;
	/** Body lines already clipped to contentWidth (no outer border). */
	body: readonly string[];
	/**
	 * Body rows this surface actually wants, when the terminal can spare fewer
	 * than the card's maximum.
	 *
	 * Without it the card is always the full height the vertical margins allow,
	 * so a seven-row list paints into a card sized for twenty and the ten blank
	 * rows below it read as a list that failed to load the rest rather than as a
	 * list that is simply short.
	 *
	 * Pass the surface's NATURAL row count, not the count currently visible: a
	 * filtered list that passed its filtered length would resize the card on every
	 * keystroke, which is worse than the empty space. The value is clamped to what
	 * fits, so a caller can pass an honest number without also doing the chrome
	 * arithmetic. Omit it to keep the full-height card.
	 */
	preferredBodyRows?: number;
	/** Optional tip candidates (LONG then SHORT). */
	tipCandidates?: readonly string[];
	shortcuts: readonly ModalShortcut[];
	/** When set, paint a search chrome row above the body. */
	searchLine?: string;
	hoveredShortcutId?: string | null;
	showClose?: boolean;
}

/**
 * Columns between a card's left edge and its body text: the border and one space of padding.
 *
 * Owned by the shell because the shell is what draws them. Every card that hit-tests its own body
 * needs the same number, and each one that spelled it `cardColStart + 2` locally was a separate
 * place to be wrong the next time the border changes.
 */
export const CARD_BODY_COL_INSET = 2;

export interface ModalShellGeometry {
	leftPad: number;
	topPad: number;
	modalWidth: number;
	modalHeight: number;
	contentWidth: number;
	/** Screen row (0-based in returned frame) where body content starts. */
	bodyRowStart: number;
	bodyRowCount: number;
	/** Screen row of the search line, or -1. */
	searchRow: number;
	footerRowStart: number;
	/** First row of shortcut chips (after tip + gap). */
	shortcutRowStart: number;
	closeColStart: number;
	closeColEnd: number;
	/** Clickable breadcrumb title span on {@link titleRow} (-1 when not clickable). */
	breadcrumbColStart: number;
	breadcrumbColEnd: number;
	titleRow: number;
	/** Absolute screen rect of the floating card. */
	cardColStart: number;
	cardColEnd: number;
	cardRowStart: number;
	cardRowEnd: number;
	/** Clickable footer chips in screen coordinates. */
	shortcutHits: readonly ShortcutHitRect[];
}

export interface ModalShellResult {
	lines: string[];
	geometry: ModalShellGeometry | null;
}

/**
 * Paint a floating modal into a full-terminal frame (empty pads around card).
 * Returns empty lines + null geometry when the terminal is too small.
 */
export function renderModalShell(input: ModalShellInput): ModalShellResult {
	const dims = computeModalDims(input.areaWidth, input.areaHeight, input.sizing);
	if (!dims) {
		return {
			lines: Array.from({ length: input.areaHeight }, () => padding(input.areaWidth)),
			geometry: null,
		};
	}

	const { modalWidth, modalHeight, leftPad, contentWidth } = dims;
	const title = input.breadcrumb ? `${input.title}${input.breadcrumb}` : input.title;

	const plan = planModalChrome({
		sizing: input.sizing,
		modalHeight,
		contentWidth,
		shortcuts: input.shortcuts,
		hoveredShortcutId: input.hoveredShortcutId,
		tipCandidates: input.tipCandidates,
		hasSearch: input.searchLine !== undefined,
	});
	const { layoutRows, tipText, vPad, tipRows, tipGap, footerBand, maxBodyRows } = plan;
	const hasSearch = input.searchLine !== undefined;
	// The card is as tall as its content asks for, bounded by what fits. A caller
	// that asks for nothing gets the full-height card it always got.
	const bodyBudget =
		input.preferredBodyRows === undefined
			? maxBodyRows
			: clamp(input.preferredBodyRows, Math.min(1, maxBodyRows), maxBodyRows);
	const cardHeight = plan.nonBody + bodyBudget;
	// Re-centre: the card shrank, so the pad above it grew by half the difference.
	const cardTopPad = Math.max(0, Math.floor((input.areaHeight - cardHeight) / 2));

	const body = [...input.body.slice(0, bodyBudget)];
	while (body.length < bodyBudget) body.push("");

	const card: string[] = [];
	let closeColStart = -1;
	let closeColEnd = -1;
	let breadcrumbColStart = -1;
	let breadcrumbColEnd = -1;
	const breadcrumbClickable = Boolean(input.breadcrumb && input.breadcrumbClickable);

	if (input.showClose !== false) {
		const closePlain = MODAL_CLOSE_CHIP;
		// Close glyph is silver structure (same as the frame), not dim soup.
		const closeStyled = theme.fg("accent", closePlain);
		const closeW = visibleWidth(closePlain);
		const box = theme.boxSharp;
		const inner = Math.max(0, modalWidth - 2);
		const shown = truncateToWidth(` ${title} `, Math.max(0, inner - closeW - 2));
		const fillWidth = Math.max(0, inner - 2 - visibleWidth(shown) - closeW);
		const clickableTitle = breadcrumbClickable ? theme.bold(theme.underline(theme.fg("accent", shown))) : "";
		const titleStyled = breadcrumbClickable
			? input.breadcrumbHovered
				? theme.bg("selectedBg", clickableTitle)
				: clickableTitle
			: theme.bold(theme.fg("accent", shown));
		const frame = (s: string) => theme.fg("borderAccent", s);
		// The title rail carries one ember tick right after the corner — the
		// website's progress-sun-on-the-header-rule motif. Geometry is identical:
		// the tick's cells occupy the space the leading rule + title space used.
		card.push(
			frame(box.topLeft) +
				emberTick(TERMINAL.trueColor, 2) +
				titleStyled +
				frame(box.horizontal.repeat(fillWidth)) +
				closeStyled +
				frame(box.topRight),
		);
		closeColStart = leftPad + 1 + 2 + visibleWidth(shown) + fillWidth;
		closeColEnd = closeColStart + closeW;
		if (breadcrumbClickable) {
			breadcrumbColStart = leftPad + 1 + 2;
			breadcrumbColEnd = breadcrumbColStart + visibleWidth(shown);
		}
	} else {
		card.push(topBorder(modalWidth, title));
	}

	let searchRowInCard = -1;
	if (hasSearch) {
		searchRowInCard = card.length;
		card.push(row(fit(input.searchLine ?? "", contentWidth), modalWidth));
		card.push(divider(modalWidth));
	}

	for (let i = 0; i < vPad; i++) {
		card.push(row("", modalWidth));
	}

	const bodyRowStartInCard = card.length;
	for (const line of body) {
		card.push(row(fit(line, contentWidth), modalWidth));
	}

	for (let i = 0; i < vPad; i++) {
		card.push(row("", modalWidth));
	}

	card.push(divider(modalWidth));
	const footerStartInCard = card.length;
	if (tipText && tipRows > 0) {
		card.push(row(theme.italic(theme.fg("dim", tipText)), modalWidth));
		if (tipGap) card.push(row("", modalWidth));
	}
	const shortcutStartInCard = card.length;
	// Content inset: border column + one space (matches overlay-box `row`).
	const contentColStart = leftPad + 2;
	const shortcutHits: ShortcutHitRect[] = [];
	for (let i = 0; i < layoutRows.length; i++) {
		const layout = layoutRows[i]!;
		const pad = Math.max(0, contentWidth - visibleWidth(layout.plain));
		const left = Math.floor(pad / 2);
		card.push(row(padding(left) + layout.styled + padding(pad - left), modalWidth));
		const screenRow = cardTopPad + shortcutStartInCard + i;
		for (const chip of layout.chips) {
			if (!chip.clickable || !chip.id) continue;
			shortcutHits.push({
				id: chip.id,
				row: screenRow,
				colStart: contentColStart + left + chip.offset,
				colEnd: contentColStart + left + chip.offset + chip.width,
			});
		}
	}
	while (card.length < footerStartInCard + footerBand) {
		card.push(row("", modalWidth));
	}
	card.push(bottomBorder(modalWidth));

	while (card.length < cardHeight) {
		card.splice(bodyRowStartInCard + body.length, 0, row("", modalWidth));
	}
	const clipped = card.slice(0, cardHeight);

	const rightPad = Math.max(0, input.areaWidth - leftPad - modalWidth);
	const frame: string[] = [];
	for (let i = 0; i < cardTopPad; i++) frame.push(padding(input.areaWidth));
	for (const line of clipped) {
		frame.push(padding(leftPad) + line + padding(rightPad));
	}
	while (frame.length < input.areaHeight) frame.push(padding(input.areaWidth));

	return {
		lines: frame.slice(0, input.areaHeight),
		geometry: {
			leftPad,
			topPad: cardTopPad,
			modalWidth,
			modalHeight: cardHeight,
			contentWidth,
			bodyRowStart: cardTopPad + bodyRowStartInCard,
			bodyRowCount: bodyBudget,
			searchRow: searchRowInCard >= 0 ? cardTopPad + searchRowInCard : -1,
			footerRowStart: cardTopPad + footerStartInCard,
			shortcutRowStart: cardTopPad + shortcutStartInCard,
			closeColStart,
			closeColEnd,
			breadcrumbColStart,
			breadcrumbColEnd,
			titleRow: cardTopPad,
			cardColStart: leftPad,
			cardColEnd: leftPad + modalWidth,
			cardRowStart: cardTopPad,
			cardRowEnd: cardTopPad + Math.min(clipped.length, cardHeight),
			shortcutHits,
		},
	};
}

/** Sentinel hover id for the clickable breadcrumb title (not a real shortcut chip). */
export const BREADCRUMB_HOVER_ID = "breadcrumb";

export type ModalChromeAction =
	| { kind: "close" }
	| { kind: "outside" }
	| { kind: "breadcrumb" }
	| { kind: "shortcut"; id: string }
	| { kind: "hover-shortcut"; id: string | null }
	| { kind: "none" };

/**
 * Hit-test ModalShell chrome: close glyph, click-outside, footer chips.
 * Body/content routing stays with the host.
 */
export function hitTestModalChrome(
	geometry: ModalShellGeometry | null,
	row: number,
	col: number,
	opts: { motion?: boolean; leftClick?: boolean } = {},
): ModalChromeAction {
	if (!geometry) return { kind: "none" };
	const inCard =
		row >= geometry.cardRowStart &&
		row < geometry.cardRowEnd &&
		col >= geometry.cardColStart &&
		col < geometry.cardColEnd;

	const overBreadcrumb =
		row === geometry.titleRow &&
		geometry.breadcrumbColStart >= 0 &&
		col >= geometry.breadcrumbColStart &&
		col < geometry.breadcrumbColEnd;

	if (opts.motion) {
		if (!inCard) return { kind: "hover-shortcut", id: null };
		if (overBreadcrumb) return { kind: "hover-shortcut", id: BREADCRUMB_HOVER_ID };
		for (const hit of geometry.shortcutHits) {
			if (row === hit.row && col >= hit.colStart && col < hit.colEnd) {
				return { kind: "hover-shortcut", id: hit.id };
			}
		}
		return { kind: "hover-shortcut", id: null };
	}

	if (!opts.leftClick) return { kind: "none" };

	if (!inCard) return { kind: "outside" };

	if (
		row === geometry.titleRow &&
		geometry.closeColStart >= 0 &&
		col >= geometry.closeColStart &&
		col < geometry.closeColEnd
	) {
		return { kind: "close" };
	}

	if (overBreadcrumb) return { kind: "breadcrumb" };

	for (const hit of geometry.shortcutHits) {
		if (row === hit.row && col >= hit.colStart && col < hit.colEnd) {
			return { kind: "shortcut", id: hit.id };
		}
	}
	return { kind: "none" };
}

/**
 * The motion half of chrome hit-testing, with the consumption answer folded
 * in. {@link hitTestModalChrome} reports EVERY motion as `"hover-shortcut"`
 * — carrying the hovered chip's id, or `null` as the clear-hover signal — so
 * a host that early-returns on the kind alone swallows every body-row
 * motion, which is exactly what every ModalShell host did: pointer hover on
 * list rows, browser rows, and settings submenu rows never reached the body
 * until this. Update the host's hovered chip (the setter fires only on
 * change, which is when a re-render is wanted) and answer whether the chrome
 * consumed the event: `true` only while the pointer is actually on a chip or
 * the breadcrumb, `false` to continue into body handling.
 */
export function consumeModalChipHover(
	chrome: ModalChromeAction,
	currentHoveredId: string | null,
	setHoveredId: (id: string | null) => void,
): boolean {
	if (chrome.kind !== "hover-shortcut") return false;
	const next = chrome.id ?? null;
	if (currentHoveredId !== next) setHoveredId(next);
	return next !== null;
}

/** Default settings footer chips (Browse layer). */
export const SETTINGS_BROWSE_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "up/down navigate" },
	{ label: "enter change" },
	{ label: "/ search" },
	{ label: "esc close", clickable: true, id: "close" },
];

export const SETTINGS_FILTER_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "up/down navigate" },
	{ label: "enter keep filter" },
	{ label: "esc clear search", clickable: true, id: "clear-filter" },
];

export const SETTINGS_SUBPANE_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "enter confirm" },
	{ label: "esc back", clickable: true, id: "back" },
];

/** Shared chips for simple list pickers (theme/thinking/queue/…). */
export const SELECT_LIST_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "navigate", keybindings: ["tui.select.up", "tui.select.down"] },
	{ label: "select", keybindings: ["tui.select.confirm"], clickable: true, id: "confirm" },
	{ label: "close", keybindings: ["tui.select.cancel"], clickable: true, id: "close" },
];

// --- Open reveal (TOUCH-5) ---------------------------------------------------

/**
 * The two quantities a card's entrance carries: how far it has unfolded, and where
 * the specular highlight has travelled to. They are read together because they are
 * one entrance; passing only the unfold is what made the arrival a wipe.
 */
export interface ModalRevealProgress {
	readonly value: number;
	/** Highlight position in [0, 1]; 1 means no highlight is crossing. */
	readonly sweep: number;
}

/**
 * Drives a one-shot open reveal for a modal card: `value` eases 0 → 1 on the
 * shared {@link motionClock} under {@link MOTION.enter}, requesting a render
 * per frame until it settles, while `sweep` carries a highlight across the card
 * on its own longer curve. The card owns no timer of its own, so every overlay in
 * the product opens on the same curve and on the same frame as anything else
 * animating, and a settled overlay costs nothing (the clock drops a finished
 * animation and stops ticking when nothing is left).
 *
 * `display.transitions: off` gating is the CALLER's job via
 * modalRevealEnabled(). Tests pass their own clock and drive frames by hand.
 */
export class ModalRevealDriver implements ModalRevealProgress {
	#armed = false;
	#animation: Animation | null = null;
	#settled = false;
	#requestRender: (() => void) | null = null;
	#exit: Animation | null = null;
	#exiting = false;
	#sweepAnimation: Animation | null = null;
	readonly #clock: MotionClock;

	constructor(clock: MotionClock = motionClock) {
		this.#clock = clock;
	}

	/**
	 * Eased reveal fraction in [0, 1]; 1 once settled or never started, and running back to 0 once
	 * the card is leaving. The timeline begins on the FIRST read after start(), not at start()
	 * itself: an overlay's first paint can lag construction by more than the whole animation
	 * (alt-screen switch, session work), and a construction-anchored clock then plays the unfold to
	 * nobody.
	 */
	get value(): number {
		// The exit outranks every other state: it is started from whatever the card was showing,
		// including mid-entrance, so a card dismissed while still opening folds away from where it
		// had got to rather than snapping open first.
		const exit = this.#exit;
		if (exit !== null) return exit.value;
		if (this.#settled || !this.#armed) return 1;
		if (this.#animation === null) {
			this.#animation = this.#clock.animate(MOTION.enter, {
				from: 0,
				to: 1,
				onFrame: () => this.#requestRender?.(),
				onDone: () => {
					this.#settled = true;
				},
			});
			return 0;
		}
		return this.#animation.value;
	}

	/** True while the card is playing its exit, which is when it must take no input. */
	get exiting(): boolean {
		return this.#exiting;
	}

	/**
	 * Where the highlight has travelled to, in [0, 1]. 1 means there is none: a
	 * settled card, a card that never played an entrance, and a card on its way out
	 * are all lit flat.
	 *
	 * The sweep runs on its own curve rather than off `value`, because it outlasts
	 * the unfold on purpose — the card is in place while the light is still moving
	 * across it. Anchored to the first READ for the same reason the unfold is: an
	 * overlay's first paint can arrive long after its construction.
	 */
	get sweep(): number {
		// A card on its way out and one that never played an entrance are lit flat.
		// `#settled` deliberately does NOT belong in this guard: the unfold finishing is
		// not the light finishing, and checking it here cut every sweep down to the
		// length of the unfold (measured on a real terminal as 250ms of a 520ms curve,
		// the light dying the instant the card stopped growing).
		if (this.#exit !== null || !this.#armed) return 1;
		if (this.#sweepAnimation === null) {
			// Nothing read the light while the entrance played, so there is none to pick up
			// mid-travel. Starting one now would light a card that is already in place —
			// and after stop(), which cancels the animation and settles, a disposed card
			// would put a fresh 520ms animation on the shared clock and report phase zero:
			// a flash of light on a card that is already gone.
			if (this.#settled) return 1;
			this.#sweepAnimation = this.#clock.animate(MOTION.sweep, {
				from: 0,
				to: 1,
				onFrame: () => this.#requestRender?.(),
			});
			return 0;
		}
		return this.#sweepAnimation.value;
	}

	/** Begin the reveal (idempotent; a second call replays from zero). */
	start(requestRender: () => void): void {
		this.stop();
		this.#settled = false;
		this.#armed = true;
		this.#animation = null;
		this.#sweepAnimation = null;
		this.#exit = null;
		this.#exiting = false;
		this.#requestRender = requestRender;
		requestRender();
	}

	/**
	 * Play the reveal BACKWARDS, then hand back to `done`.
	 *
	 * Returns false when there is nothing to play — a card already leaving — and the caller removes
	 * it on the spot. The exit is the shorter curve on purpose: an entrance can be admired, but
	 * waiting on something you have already dismissed reads as the program being slow rather than
	 * the card being graceful.
	 */
	exit(requestRender: () => void, done: () => void): boolean {
		if (this.#exiting) return false;
		const from = this.value;
		this.#animation?.cancel();
		this.#animation = null;
		// A leaving card is not being lit. `get sweep` returns 1 once an exit exists, so
		// the animation has no reader left and would only keep the clock alive.
		this.#sweepAnimation?.cancel();
		this.#sweepAnimation = null;
		this.#settled = false;
		this.#exiting = true;
		this.#requestRender = requestRender;
		this.#exit = this.#clock.animate(MOTION.exit, {
			from,
			to: 0,
			onFrame: () => this.#requestRender?.(),
			onDone: () => {
				this.#requestRender = null;
				done();
			},
		});
		requestRender();
		return true;
	}

	/** Settle immediately (also used on dismount so no frame outlives the card). */
	stop(): void {
		// The entrance is CANCELLED: a dismount must not ask a disposed card to repaint.
		this.#animation?.cancel();
		this.#animation = null;
		// The sweep is a light crossing a card that no longer exists, and it is the one
		// animation here that outlives the unfold: MOTION.sweep is twice MOTION.enter, so
		// a card dismissed while the light is still travelling left a live animation on
		// the clock and the clock ticking with nothing to show.
		this.#sweepAnimation?.cancel();
		this.#sweepAnimation = null;
		// An exit is FINISHED instead, because its `onDone` is what removes the card from the
		// overlay stack. Cancelling one would leave a dismissed card painted on screen with nothing
		// left running to take it off — the exit turning a close into a permanent overlay is a worse
		// failure than any missed frame. The finish runs synchronously, so no frame is painted
		// between clearing the state here and the host dropping the card.
		const exit = this.#exit;
		this.#exit = null;
		this.#requestRender = null;
		this.#settled = true;
		exit?.finish();
	}
}

/**
 * Start a card's exit under the ambient motion gate, which is the same gate the open unfold is
 * shown under: a terminal that skips the entrance must not be handed an exit.
 *
 * Returns false when nothing will play, which is the host's signal to remove the card at once
 * rather than wait for a frame that is never coming.
 */
export function beginModalExit(reveal: ModalRevealDriver, requestRender: () => void, done: () => void): boolean {
	return modalRevealEnabled() && reveal.exit(requestRender, done);
}

/**
 * Ambient gate for the open unfold, decided at the SHOW site (single owner):
 * `display.transitions: off` turns structural motion off, and non-truecolor
 * terminals skip motion entirely (the reveal clip itself is color-agnostic,
 * but sub-frame chrome motion on 16-color terminals reads as flicker).
 * Components never read this themselves — they honor `options.reveal` blindly,
 * which keeps direct constructions (tests, embedders) deterministic.
 */
export function modalRevealEnabled(): boolean {
	return TERMINAL.trueColor && transitionsEnabled();
}

/**
 * The color a card resolves out of while it unfolds. One owner, in the theme:
 * the pointer band fades out of the same ground, and two policies for "what is
 * behind this row" drift into two different washes on the same screen. That
 * ground is the one on SCREEN, not the one the theme declares — see
 * {@link visibleGroundHex}.
 */
export function modalRevealGround(): string {
	return visibleGroundHex();
}

/**
 * Whether a card may be painted as a surface at all, and out of which colour.
 *
 * A surface is an explicit background on every cell of the card, so it is only
 * ever as safe as the ground it is mixed out of. `visibleGroundHex` falls back to
 * the theme's DECLARED ground when nothing painted and the terminal answered no
 * OSC 11 — titanium declares black — and a black-derived fill laid on a grey
 * terminal is the slab that shipped on 2026-07-22, which is also what the pointer
 * band suites forbid in as many words.
 *
 * So: a known ground gets the material, an unknown one gets the product exactly as
 * it was. The clip and the fade are colour-agnostic and play either way.
 */
function modalSurfaceGround(ground: string): string | undefined {
	return getVisibleGround() === undefined ? undefined : ground;
}

/**
 * The elevation ladder a card is made of, top to bottom.
 *
 * One wash over the whole card was measured on a real terminal at twelve of 255
 * above the page at its top row and four at its foot: an elevation the eye cannot
 * find, so a settled card still read as line art on the page. Three materials fix
 * that without brightening anything into a slab — a header tray carrying the title
 * and the search line, the body in front of it, and a recessed footer tray under
 * the tip and the chips. The ladder is what gives the eye an edge to catch.
 */
const CARD_HEADER_LIFT = 0.15;
const CARD_BODY_LIFT = 0.1;
const CARD_BODY_BOTTOM_LIFT = 0.07;
const CARD_TRAY_LIFT = 0.04;
/** A pane the card sets INTO its own body: a category sidebar, a preview column. */
const CARD_INSET_LIFT = 0.025;

/**
 * The material a two-pane card sets its side column in, or undefined when this
 * terminal gets no material at all.
 *
 * The shell cannot do this one itself: it is handed finished body rows and has no
 * idea where a component split them. So the component paints its own inset, and
 * because {@link applyModalReveal} never overpaints a cell that already carries a
 * background, the inset survives the fill that follows it.
 */
export function cardInsetHex(): string | undefined {
	const ground = modalSurfaceGround(modalRevealGround());
	if (ground === undefined || !TERMINAL.trueColor) return undefined;
	return liftHex(ground, CARD_INSET_LIFT);
}

/**
 * Set one pane of a two-pane card INTO the card: the same rendered columns, on the
 * inset material.
 *
 * `width` is the pane's own width, and the paint stops there, so the hairline and
 * the pane beside it keep the plate. A terminal with no material gets the line
 * back unchanged, which is the byte-identity the card suites assert.
 */
export function paintCardInset(line: string, width: number): string {
	const inset = cardInsetHex();
	if (inset === undefined) return line;
	return paintLineBackground(line, width, ({ background }) => (background === undefined ? inset : undefined), {
		start: 0,
		end: width,
	});
}

/**
 * Paint a rendered modal frame as a SURFACE, and play its entrance.
 *
 * Three things happen here, and the order matters:
 *
 *   1. The card's rows are filled with an elevation gradient — a few percent off
 *      the ground the terminal is actually showing, lighter at the top edge than
 *      the bottom. This is not part of the animation: a settled card is still a
 *      surface. Cells the component gave their own background keep it.
 *   2. While the entrance runs, the card is clipped to the rows it has grown to
 *      and each row resolves out of the ground on ITS OWN ramp. A single strength
 *      for the whole block gives an animation as many distinct frames as the card
 *      has rows, which is why the unfold read as a cut with a moving edge; a
 *      cascade gives every row a continuous fade and the overlap is what the eye
 *      reads as one smooth motion. The bottom border still slides down with the
 *      body, so the card is never a borderless sliver.
 *   3. One specular highlight crosses the card, on a curve that outlasts the
 *      unfold. This is the only motion in the product with a frame for every frame
 *      of the clock: it moves through colour rather than through terminal rows, so
 *      it cannot look stepped.
 *
 * Pure, so every frame is byte-assertable. Takes the whole {@link ModalRevealProgress}
 * rather than one number because the entrance is two quantities; a bare number is
 * still accepted, which is what a test that only cares about the unfold passes.
 */
export function applyModalReveal(
	result: ModalShellResult,
	areaWidth: number,
	reveal: number | ModalRevealProgress,
	ground: string = modalRevealGround(),
): string[] {
	const progress = typeof reveal === "number" ? { value: reveal, sweep: 1 } : reveal;
	const geometry = result.geometry;
	if (geometry === null) return result.lines;
	// cardRowEnd is EXCLUSIVE (see hitTestModalChrome's `row < cardRowEnd`).
	const { cardRowStart, cardRowEnd, cardColStart, cardColEnd } = geometry;
	const cardRows = cardRowEnd - cardRowStart;
	const card = result.lines.slice(cardRowStart, cardRowEnd);
	// The card's own columns. A card row is as wide as the screen, and the padding
	// that centres it belongs to the page: a treatment given the whole row puts the
	// card's material and its light out on the page beside it.
	const columns: ColumnWindow = { start: cardColStart, end: cardColEnd };

	const strength = clamp(progress.value, 0, 1);
	// The surface and the sweep are written as `48;2;r;g;b` mixed out of the ground
	// behind the card, so both need a truecolor terminal AND a ground that is known
	// rather than assumed (see modalSurfaceGround). Without either, the product is
	// exactly what it was; the clip and the fade below are colour-agnostic and play.
	const surface = TERMINAL.trueColor ? modalSurfaceGround(ground) : undefined;
	// Header tray: the top border, the title rail, and the search line if there is
	// one — everything above the first body row. Footer tray: the tip, the chips and
	// the bottom border. Rows are relative to the card block, `end` exclusive.
	const bands: readonly SurfaceBand[] = [
		{ start: 0, end: Math.max(1, geometry.bodyRowStart - cardRowStart), lift: CARD_HEADER_LIFT },
		{ start: Math.max(0, geometry.footerRowStart - cardRowStart), end: cardRows, lift: CARD_TRAY_LIFT },
	];
	let treated =
		surface === undefined
			? card
			: fillSurface(
					card,
					areaWidth,
					{
						ground: surface,
						lift: CARD_BODY_LIFT,
						bottomLift: CARD_BODY_BOTTOM_LIFT,
						bands,
						columns,
					},
					strength,
				);

	// How many rows of the card are on screen this frame. Everything below is blank
	// page, and nothing may be painted onto it — a swept blank row is light lying
	// outside the card, which reads as a bug rather than as a reflection.
	let visibleRows = cardRows;
	if (strength < 1) {
		const visible = Math.max(2, Math.round(cardRows * strength));
		visibleRows = visible;
		// Per-row cascade. One strength for the whole card gives an animation as
		// many distinct frames as the card has rows, and it reads as a cut with a
		// moving edge; a row that owns its own ramp gives every row a continuous
		// fade, and the overlap is what the eye reads as smooth.
		treated = treated.map((line, cardRow) => {
			if (cardRow < visible - 1) {
				return fadeLineTowards(line, ground, cascadeStrength(cardRow, cardRows, strength));
			}
			// The bottom border slides down as the body grows, so the card always
			// closes: a borderless sliver is not a card opening.
			if (cardRow === visible - 1) {
				return fadeLineTowards(treated[cardRows - 1] ?? line, ground, cascadeStrength(cardRow, cardRows, strength));
			}
			return padding(areaWidth);
		});
	}

	// The specular sweep: one highlight crossing the card as it arrives. This is
	// the part of the entrance that has a frame for every frame of the clock,
	// because it moves through colour instead of through rows.
	if (surface !== undefined && progress.sweep > 0 && progress.sweep < 1) {
		const lit = sweepSurface(treated.slice(0, visibleRows), areaWidth, surface, { phase: progress.sweep, columns });
		treated = [...lit, ...treated.slice(visibleRows)];
	}

	// Nothing was treated: no material to paint, settled, no sweep. The frame it was
	// handed IS the answer, and handing back the same array keeps a settled overlay off
	// the allocator entirely -- this runs on every frame the overlay is open, and a copy
	// of every row per frame is the one cost an entrance has no business charging after
	// it has finished.
	if (treated === card) return result.lines;

	const lines = [...result.lines];
	for (let i = 0; i < treated.length; i++) lines[cardRowStart + i] = treated[i]!;
	return lines;
}
