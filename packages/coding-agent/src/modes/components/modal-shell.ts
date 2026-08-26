/**
 * ModalShell — shared floating overlay chrome for Veyyon TUI surfaces.
 */
import { clamp, clampLow, type Keybinding, padding, TERMINAL, truncateToWidth, visibleWidth } from "@veyyon/tui";
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
 * Returns the minimum chrome rows reserved outside the modal body for borders, padding, and footers.
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
 * Resolves the chrome reservation and maximum available body rows for a modal card.
 */
export function planModalChrome(input: {
	sizing: ModalSizing;
	modalHeight: number;
	contentWidth: number;
	shortcuts?: readonly ModalShortcut[];
	hoveredShortcutId?: string | null;
	tipCandidates?: readonly string[];
	hasSearch?: boolean;
}): ModalChromePlan {
	const { sizing, modalHeight, contentWidth } = input;
	const layoutRows = layoutShortcutRows(input.shortcuts ?? [], contentWidth, input.hoveredShortcutId);
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
 * Determines whether a modal height requires compact padding to prevent crowding content.
 */
export function modalNeedsCompactPadding(areaHeight: number, sizing: ModalSizing): boolean {
	return areaHeight - 2 * sizing.vMargin <= MODAL_MIN_TALL_ROWS;
}

/**
 * Selects the active ModalSizing for a given area height, shedding padding when space-constrained.
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
 * Returns the card width needed to render title text of `titleWidth` without truncation.
 */
export function modalWidthForTitle(titleWidth: number): number {
	return titleWidth + 2 + 2 + 2 + visibleWidth(MODAL_CLOSE_CHIP);
}

/**
 * Returns available content width for a medium modal in the given terminal dimensions.
 */
export function mediumModalContentWidth(areaWidth: number, areaHeight: number): number | null {
	const dims = computeModalDims(areaWidth, areaHeight, sizingForArea(MODAL_SIZING_MEDIUM, areaHeight));
	return dims ? dims.contentWidth : null;
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
 * Packs shortcut chip widths into row groups using greedy forward allocation.
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
	 * Desired natural body row count, clamped to available space to prevent oversized modals.
	 */
	preferredBodyRows?: number;
	/** Optional tip candidates (LONG then SHORT). */
	tipCandidates?: readonly string[];
	shortcuts?: readonly ModalShortcut[];
	/** When set, paint a search chrome row above the body. */
	searchLine?: string;
	hoveredShortcutId?: string | null;
	showClose?: boolean;
}

/**
 * Column inset between card outer edge and inner body text (border + padding).
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
			lines: Array(input.areaHeight).fill(padding(input.areaWidth)),
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
 * Handles hover state transitions for modal footer chips, returning true if chrome consumed the event.
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

// --- Pointer-band motion ----------------------------------------------------

/**
 * Ambient gate for pointer-band motion on modal surfaces:
 * `display.transitions: off` turns structural motion off, and non-truecolor
 * terminals skip motion entirely.
 */
export function pointerMotionEnabled(): boolean {
	return TERMINAL.trueColor && transitionsEnabled();
}

/**
 * The color the pointer band fades out of on a modal card. One owner, in the theme.
 */
export function modalRevealGround(): string {
	return visibleGroundHex();
}
