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
import { clamp, clampLow, padding, TERMINAL, truncateToWidth, visibleWidth } from "@veyyon/tui";
import { shimmerEnabled } from "../theme/shimmer";
import { theme } from "../theme/theme";
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

/** Compact strip: reclaim vertical margin when the terminal is short. */
export function withCompact(sizing: ModalSizing, compact: boolean): ModalSizing {
	if (!compact) return sizing;
	return { ...sizing, vMargin: 0, hPad: 1, vPad: 0 };
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
	const modalHeight = Math.max(0, areaHeight - 2 * sizing.vMargin);
	if (modalWidth < 20 || modalHeight < 6) return null;
	const leftPad = Math.max(0, Math.floor((areaWidth - modalWidth) / 2));
	const topPad = Math.max(0, Math.floor((areaHeight - modalHeight) / 2));
	const contentWidth = Math.max(1, modalWidth - 2 - 2 * Math.max(1, sizing.hPad));
	return { modalWidth, modalHeight, leftPad, topPad, contentWidth };
}

/** One footer chip. `clickable` marks action vs inert hint (mouse targets). */
export interface ModalShortcut {
	/** Display like "esc close" or "enter change" — first token is the key. */
	label: string;
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

interface ShortcutLayoutRow {
	plain: string;
	styled: string;
	/** Chip placements within the content column (before centering pad). */
	chips: { id?: string; clickable: boolean; offset: number; width: number }[];
}

export function layoutShortcutRows(
	shortcuts: readonly ModalShortcut[],
	width: number,
	hoveredId?: string | null,
): ShortcutLayoutRow[] {
	if (width <= 0 || shortcuts.length === 0) return [];
	const chips = shortcuts.map(s => ({
		id: s.id,
		clickable: Boolean(s.clickable && s.id),
		plain: s.label,
		styled: styleShortcutChip(s.label, Boolean(s.id && s.id === hoveredId)),
		w: visibleWidth(s.label),
	}));
	const sepW = visibleWidth(SHORTCUT_SEP);

	// Greedy forward pass: pack as many chips per row as fit. This is optimal
	// for the row *count* (can't reorder chips), but can strand a lone trailing
	// chip whose row-mates all landed on the row above.
	const groups: number[][] = [];
	let current: number[] = [];
	let currentW = 0;
	for (let i = 0; i < chips.length; i++) {
		const chip = chips[i]!;
		const extra = current.length === 0 ? chip.w : sepW + chip.w;
		if (current.length > 0 && currentW + extra > width) {
			groups.push(current);
			current = [i];
			currentW = chip.w;
		} else {
			current.push(i);
			currentW += extra;
		}
	}
	if (current.length > 0) groups.push(current);

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
	/** Optional tip candidates (LONG then SHORT). */
	tipCandidates?: readonly string[];
	shortcuts: readonly ModalShortcut[];
	/** When set, paint a search chrome row above the body. */
	searchLine?: string;
	hoveredShortcutId?: string | null;
	showClose?: boolean;
}

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

	const { modalWidth, modalHeight, leftPad, topPad, contentWidth } = dims;
	const title = input.breadcrumb ? `${input.title}${input.breadcrumb}` : input.title;

	const layoutRows = layoutShortcutRows(input.shortcuts, contentWidth, input.hoveredShortcutId);
	const tipText = input.tipCandidates?.length ? fitTipLine(input.tipCandidates, contentWidth) : "";

	const hasSearch = input.searchLine !== undefined;
	const searchChrome = hasSearch ? 2 : 0;
	// Chips (or the caller's reserved footer lines) plus the top border, footer
	// divider, and bottom border are mandatory chrome — they must never be
	// clipped. The tip line, its gap, and the vertical padding are droppable, in
	// that order, when the card is too short (e.g. a search+tip overlay on a
	// 24-row terminal, where a naive slice would shear off the bottom border).
	const shortcutRows = layoutRows.length;
	let vPad = input.sizing.vPad;
	let tipRows = tipText ? 1 : 0;
	let tipGap = tipRows > 0 && modalHeight >= 6 ? 1 : 0;
	let footerBand = Math.max(input.sizing.footerLines, shortcutRows + tipRows + tipGap);
	const nonBody = () => 1 + searchChrome + vPad + 1 + footerBand + 1;
	const refreshFooterBand = () => {
		footerBand = Math.max(input.sizing.footerLines, shortcutRows + tipRows + tipGap);
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

	const bodyBudget = Math.max(0, modalHeight - nonBody());

	const body = [...input.body.slice(0, bodyBudget)];
	while (body.length < bodyBudget) body.push("");

	const card: string[] = [];
	let closeColStart = -1;
	let closeColEnd = -1;
	let breadcrumbColStart = -1;
	let breadcrumbColEnd = -1;
	const breadcrumbClickable = Boolean(input.breadcrumb && input.breadcrumbClickable);

	if (input.showClose !== false) {
		const closePlain = " [x] ";
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
		const screenRow = topPad + shortcutStartInCard + i;
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

	while (card.length < modalHeight) {
		card.splice(bodyRowStartInCard + body.length, 0, row("", modalWidth));
	}
	const clipped = card.slice(0, modalHeight);

	const rightPad = Math.max(0, input.areaWidth - leftPad - modalWidth);
	const frame: string[] = [];
	for (let i = 0; i < topPad; i++) frame.push(padding(input.areaWidth));
	for (const line of clipped) {
		frame.push(padding(leftPad) + line + padding(rightPad));
	}
	while (frame.length < input.areaHeight) frame.push(padding(input.areaWidth));

	return {
		lines: frame.slice(0, input.areaHeight),
		geometry: {
			leftPad,
			topPad,
			modalWidth,
			modalHeight,
			contentWidth,
			bodyRowStart: topPad + bodyRowStartInCard,
			bodyRowCount: bodyBudget,
			searchRow: searchRowInCard >= 0 ? topPad + searchRowInCard : -1,
			footerRowStart: topPad + footerStartInCard,
			shortcutRowStart: topPad + shortcutStartInCard,
			closeColStart,
			closeColEnd,
			breadcrumbColStart,
			breadcrumbColEnd,
			titleRow: topPad,
			cardColStart: leftPad,
			cardColEnd: leftPad + modalWidth,
			cardRowStart: topPad,
			cardRowEnd: topPad + Math.min(clipped.length, modalHeight),
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
	{ label: "up/down navigate" },
	{ label: "enter select", clickable: true, id: "confirm" },
	{ label: "esc close", clickable: true, id: "close" },
];

// --- Open reveal (TOUCH-5) ---------------------------------------------------

/** Total reveal duration. Short enough that a fast typist never waits on it. */
const REVEAL_MS = 130;
const REVEAL_TICK_MS = 33;

/**
 * Drives a one-shot open reveal for a modal card: `value` eases 0 → 1 over
 * {@link REVEAL_MS}, ticking a re-render until settled. Follows the welcome
 * bloom's convention (interval + requestRender, `display.shimmer: disabled`
 * gating is the CALLER's job via shimmerEnabled()). Idle after settling: the
 * timer self-clears, so a settled overlay costs nothing per frame.
 */
export class ModalRevealDriver {
	#armed = false;
	#start: number | null = null;
	#timer: NodeJS.Timeout | null = null;
	#settled = false;

	/**
	 * Eased reveal fraction in [0, 1]; 1 once settled or never started. The
	 * timeline begins on the FIRST read after start(), not at start() itself:
	 * an overlay's first paint can lag construction by more than the whole
	 * animation (alt-screen switch, session work), and a construction-anchored
	 * clock then plays the unfold to nobody.
	 */
	get value(): number {
		if (this.#settled) return 1;
		if (!this.#armed) return 1;
		if (this.#start === null) {
			this.#start = performance.now();
			return 0;
		}
		const t = Math.min(1, (performance.now() - this.#start) / REVEAL_MS);
		// easeOutCubic: fast unfold, gentle landing.
		return 1 - (1 - t) ** 3;
	}

	/** Begin the reveal (idempotent; a second call replays from zero). */
	start(requestRender: () => void): void {
		this.stop();
		this.#settled = false;
		this.#armed = true;
		this.#start = null;
		this.#timer = setInterval(() => {
			// The settle deadline counts from first paint; keep ticking until the
			// timeline has both started and elapsed.
			if (this.#start !== null && performance.now() - this.#start >= REVEAL_MS) this.stop();
			requestRender();
		}, REVEAL_TICK_MS);
		requestRender();
	}

	/** Settle immediately (also used on dismount so no timer outlives the card). */
	stop(): void {
		if (this.#timer !== null) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
		this.#settled = true;
	}
}

/**
 * Ambient gate for the open unfold, decided at the SHOW site (single owner):
 * `display.shimmer: disabled` turns all chrome animation off, and non-truecolor
 * terminals follow the welcome bloom's convention of skipping motion entirely.
 * Components never read this themselves — they honor `options.reveal` blindly,
 * which keeps direct constructions (tests, embedders) deterministic.
 */
export function modalRevealEnabled(): boolean {
	return TERMINAL.trueColor && shimmerEnabled();
}

/**
 * Clip a rendered modal frame to an unfolding card: the top border stays put,
 * the bottom border slides down as the body grows. Pure so the exact frames
 * are byte-assertable in tests. `reveal >= 1` returns the lines untouched;
 * during the unfold every hidden card row becomes a blank area row, so nothing
 * below the moving bottom border ever paints. The minimum visible card is the
 * two border rows — a reveal never shows a borderless sliver.
 */
export function applyModalReveal(result: ModalShellResult, areaWidth: number, reveal: number): string[] {
	const geometry = result.geometry;
	if (geometry === null || reveal >= 1) return result.lines;
	// cardRowEnd is EXCLUSIVE (see hitTestModalChrome's `row < cardRowEnd`).
	const { cardRowStart, cardRowEnd } = geometry;
	const cardRows = cardRowEnd - cardRowStart;
	const visible = Math.max(2, Math.round(cardRows * Math.max(0, reveal)));
	if (visible >= cardRows) return result.lines;
	const blank = padding(areaWidth);
	return result.lines.map((line, row) => {
		if (row < cardRowStart || row >= cardRowEnd) return line;
		const cardRow = row - cardRowStart;
		if (cardRow < visible - 1) return line; // top border + grown body rows
		if (cardRow === visible - 1) return result.lines[cardRowEnd - 1]!; // bottom border, slid up
		return blank;
	});
}
