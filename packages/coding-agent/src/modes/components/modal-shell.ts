import { clamp, clampLow, type Keybinding, padding, TERMINAL, truncateToWidth, visibleWidth } from "@veyyon/tui";
import { transitionsEnabled } from "../theme/shimmer";
import { theme, visibleGroundHex } from "../theme/theme";
import { actionKeyHint } from "../utils/key-hint";
import { emberTick } from "./composer-chrome";
import { bottomBorder, divider, fit, row, topBorder } from "./overlay-box";

export const TITLE_LEADING_DECORATION_W = 2;

export const FOLD_COLS = 2;

export interface ModalSizing {
	widthPct: number;
	maxWidth: number;
	minWidth: number;
	vMargin: number;
	hPad: number;
	vPad: number;
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

export const MODAL_SIZING_SETTINGS: ModalSizing = {
	widthPct: 0.8,
	maxWidth: 124,
	minWidth: 44,
	vMargin: 3,
	hPad: 2,
	vPad: 1,
	footerLines: 2,
};

export function minModalChromeRows(sizing: ModalSizing): number {
	const topBorder = 1;
	const footerDivider = 1;
	const bottomBorder = 1;
	return topBorder + 2 * sizing.vPad + footerDivider + sizing.footerLines + bottomBorder;
}

export interface ModalChromePlan {
	layoutRows: ShortcutLayoutRow[];
	tipText: string;
	searchChrome: number;
	vPad: number;
	tipRows: number;
	tipGap: number;
	footerBand: number;
	nonBody: number;
	maxBodyRows: number;
}

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

	const shortcutRows = layoutRows.length;
	let vPad = sizing.vPad;
	let tipRows = tipText ? 1 : 0;
	let tipGap = tipRows > 0 && modalHeight >= 6 ? 1 : 0;
	let footerBand = Math.max(sizing.footerLines, shortcutRows + tipRows + tipGap);
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

const MODAL_MIN_TALL_ROWS = 24;

export function modalNeedsCompactPadding(areaHeight: number, sizing: ModalSizing): boolean {
	return areaHeight - 2 * sizing.vMargin <= MODAL_MIN_TALL_ROWS;
}

export function sizingForArea(sizing: ModalSizing, areaHeight: number, forceCompact = false): ModalSizing {
	if (!forceCompact && !modalNeedsCompactPadding(areaHeight, sizing)) return sizing;
	return { ...sizing, hPad: 1, vPad: 0 };
}

export interface ModalDims {
	modalWidth: number;
	modalHeight: number;
	leftPad: number;
	topPad: number;
	contentWidth: number;
}

export function computeModalDims(areaWidth: number, areaHeight: number, sizing: ModalSizing): ModalDims | null {
	const maxWidth = clamp(areaWidth - 4, 0, sizing.maxWidth);
	const preferred = Math.floor(areaWidth * sizing.widthPct);
	const modalWidth = Math.min(areaWidth, clampLow(preferred, sizing.minWidth, maxWidth));
	const floorRows = Math.min(areaHeight, MODAL_MIN_TALL_ROWS + 4 * sizing.vPad);
	const modalHeight = Math.max(areaHeight - 2 * sizing.vMargin, floorRows);
	if (modalWidth < 20 || modalHeight < 6) return null;
	const leftPad = Math.max(0, Math.floor((areaWidth - modalWidth) / 2));
	const topPad = Math.max(0, Math.floor((areaHeight - modalHeight) / 2));
	const contentWidth = Math.max(1, modalWidth - 2 - 2 * Math.max(1, sizing.hPad));
	return { modalWidth, modalHeight, leftPad, topPad, contentWidth };
}

const MODAL_CLOSE_CHIP = " [x] ";

export function modalWidthForContent(contentWidth: number, sizing: ModalSizing): number {
	return contentWidth + 2 + 2 * Math.max(1, sizing.hPad);
}

export function modalWidthForTitle(titleWidth: number): number {
	return titleWidth + 2 + 2 + 2 + visibleWidth(MODAL_CLOSE_CHIP);
}

export function mediumModalContentWidth(areaWidth: number, areaHeight: number): number | null {
	const dims = computeModalDims(areaWidth, areaHeight, sizingForArea(MODAL_SIZING_MEDIUM, areaHeight));
	return dims ? dims.contentWidth : null;
}

export interface ModalShortcut {
	label: string;
	keybindings?: readonly Keybinding[];
	clickable?: boolean;
	id?: string;
}

export interface ShortcutHitRect {
	id: string;
	row: number;
	colStart: number;
	colEnd: number;
}

const SHORTCUT_SEP = "  ·  ";

function styleShortcutChip(label: string, hovered: boolean): string {
	const space = label.indexOf(" ");
	const key = space === -1 ? label : label.slice(0, space);
	const rest = space === -1 ? "" : label.slice(space);
	const keyStyled = theme.bold(theme.fg("accent", key));
	const restStyled = rest ? theme.fg(hovered ? "muted" : "dim", rest) : "";
	const chip = `${keyStyled}${restStyled}`;
	return hovered ? theme.bg("selectedBg", chip) : chip;
}

export interface ShortcutLayoutRow {
	plain: string;
	styled: string;
	chips: { id?: string; clickable: boolean; offset: number; width: number }[];
}

function resolveShortcutLabels(shortcuts: readonly ModalShortcut[]): ModalShortcut[] {
	const resolved: ModalShortcut[] = [];
	for (let si = 0; si < shortcuts.length; si++) {
		const shortcut = shortcuts[si]!;
		if (!shortcut.keybindings) {
			resolved.push(shortcut);
			continue;
		}
		const keys: string[] = [];
		if (shortcut.keybindings) {
			for (let ki = 0; ki < shortcut.keybindings.length; ki++) {
				const hint = actionKeyHint(shortcut.keybindings[ki]!);
				if (hint) keys.push(hint);
			}
		}
		if (keys.length === 0) continue;
		resolved.push({ ...shortcut, label: `${keys.join("/")} ${shortcut.label}` });
	}
	return resolved;
}

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
	const chips = new Array<{ id: string | undefined; clickable: boolean; plain: string; styled: string; w: number }>(
		resolvedShortcuts.length,
	);
	for (let si = 0; si < resolvedShortcuts.length; si++) {
		const s = resolvedShortcuts[si]!;
		chips[si] = {
			id: s.id,
			clickable: Boolean(s.clickable && s.id),
			plain: s.label,
			styled: styleShortcutChip(s.label, Boolean(s.id && s.id === hoveredId)),
			w: visibleWidth(s.label),
		};
	}
	const sepW = visibleWidth(SHORTCUT_SEP);
	const chipWidths = new Array<number>(chips.length);
	for (let ci = 0; ci < chips.length; ci++) chipWidths[ci] = chips[ci]!.w;
	const groups = packChipRows(chipWidths, width, sepW);

	const groupWidth = (indices: number[]): number => {
		let w = 0;
		for (let ii = 0; ii < indices.length; ii++) w += chips[indices[ii]!]!.w + (ii > 0 ? sepW : 0);
		return w;
	};

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

	const rows = new Array<ShortcutLayoutRow>(groups.length);
	for (let gi = 0; gi < groups.length; gi++) {
		const indices = groups[gi]!;
		let plain = "";
		let styled = "";
		let w = 0;
		const rowChips: ShortcutLayoutRow["chips"] = [];
		for (let ii = 0; ii < indices.length; ii++) {
			const chip = chips[indices[ii]!]!;
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
		rows[gi] = { plain, styled, chips: rowChips };
	}
	return rows;
}

export function renderModalShortcuts(
	shortcuts: readonly ModalShortcut[],
	width: number,
	hoveredId?: string | null,
): string[] {
	const rows = layoutShortcutRows(shortcuts, width, hoveredId);
	const lines = new Array<string>(rows.length);
	for (let ri = 0; ri < rows.length; ri++) {
		const { plain, styled } = rows[ri]!;
		const pad = Math.max(0, width - visibleWidth(plain));
		const left = Math.floor(pad / 2);
		lines[ri] = padding(left) + styled + padding(pad - left);
	}
	return lines;
}

export function fitTipLine(candidates: readonly string[], width: number): string {
	if (width <= 0 || candidates.length === 0) return "";
	for (let ci = 0; ci < candidates.length; ci++) {
		if (visibleWidth(candidates[ci]!) <= width) return candidates[ci]!;
	}
	return truncateToWidth(candidates[candidates.length - 1] ?? "", width);
}

export function foldCollapsedGlyph(hovered = false): string {
	const g = `${theme.nav.expand} `;
	return hovered ? theme.bold(theme.fg("accent", g)) : theme.fg("dim", g);
}

export function foldExpandedGlyph(hovered = false): string {
	const g = `${theme.nav.collapse} `;
	return hovered ? theme.bold(theme.fg("accent", g)) : theme.fg("dim", g);
}

export interface ModalShellInput {
	title: string;
	breadcrumb?: string;
	breadcrumbClickable?: boolean;
	breadcrumbHovered?: boolean;
	sizing: ModalSizing;
	areaWidth: number;
	areaHeight: number;
	body: readonly string[];
	preferredBodyRows?: number;
	tipCandidates?: readonly string[];
	shortcuts?: readonly ModalShortcut[];
	searchLine?: string;
	hoveredShortcutId?: string | null;
	showClose?: boolean;
}

export const CARD_BODY_COL_INSET = 2;

export interface ModalShellGeometry {
	leftPad: number;
	topPad: number;
	modalWidth: number;
	modalHeight: number;
	contentWidth: number;
	bodyRowStart: number;
	bodyRowCount: number;
	searchRow: number;
	footerRowStart: number;
	shortcutRowStart: number;
	closeColStart: number;
	closeColEnd: number;
	breadcrumbColStart: number;
	breadcrumbColEnd: number;
	titleRow: number;
	cardColStart: number;
	cardColEnd: number;
	cardRowStart: number;
	cardRowEnd: number;
	shortcutHits: readonly ShortcutHitRect[];
}

export interface ModalShellResult {
	lines: string[];
	geometry: ModalShellGeometry | null;
}

export function renderModalShell(input: ModalShellInput): ModalShellResult {
	const dims = computeModalDims(input.areaWidth, input.areaHeight, input.sizing);
	if (!dims) {
		return {
			lines: new Array(input.areaHeight).fill(padding(input.areaWidth)),
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
	const bodyBudget =
		input.preferredBodyRows === undefined
			? maxBodyRows
			: clamp(input.preferredBodyRows, Math.min(1, maxBodyRows), maxBodyRows);
	const cardHeight = plan.nonBody + bodyBudget;
	const cardTopPad = Math.max(0, Math.floor((input.areaHeight - cardHeight) / 2));

	const body = input.body.slice(0, bodyBudget);
	while (body.length < bodyBudget) body.push("");

	const card: string[] = [];
	let closeColStart = -1;
	let closeColEnd = -1;
	let breadcrumbColStart = -1;
	let breadcrumbColEnd = -1;
	const breadcrumbClickable = Boolean(input.breadcrumb && input.breadcrumbClickable);

	if (input.showClose !== false) {
		const closePlain = MODAL_CLOSE_CHIP;
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
	for (let bi = 0; bi < body.length; bi++) {
		card.push(row(fit(body[bi]!, contentWidth), modalWidth));
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
	const contentColStart = leftPad + 2;
	const shortcutHits: ShortcutHitRect[] = [];
	for (let i = 0; i < layoutRows.length; i++) {
		const layout = layoutRows[i]!;
		const pad = Math.max(0, contentWidth - visibleWidth(layout.plain));
		const left = Math.floor(pad / 2);
		card.push(row(padding(left) + layout.styled + padding(pad - left), modalWidth));
		const screenRow = cardTopPad + shortcutStartInCard + i;
		for (let ci = 0; ci < layout.chips.length; ci++) {
			const chip = layout.chips[ci]!;
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
	for (let ci = 0; ci < clipped.length; ci++) {
		frame.push(padding(leftPad) + clipped[ci]! + padding(rightPad));
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

export const BREADCRUMB_HOVER_ID = "breadcrumb";

export type ModalChromeAction =
	| { kind: "close" }
	| { kind: "outside" }
	| { kind: "breadcrumb" }
	| { kind: "shortcut"; id: string }
	| { kind: "hover-shortcut"; id: string | null }
	| { kind: "none" };

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

export const SELECT_LIST_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "navigate", keybindings: ["tui.select.up", "tui.select.down"] },
	{ label: "select", keybindings: ["tui.select.confirm"], clickable: true, id: "confirm" },
	{ label: "close", keybindings: ["tui.select.cancel"], clickable: true, id: "close" },
];

export function pointerMotionEnabled(): boolean {
	return TERMINAL.trueColor && transitionsEnabled();
}

export function modalRevealGround(): string {
	return visibleGroundHex();
}
