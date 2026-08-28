import type { GhosttyCell, GhosttyTerminal } from "ghostty-web";
import { DEFAULT_BG_B, DEFAULT_BG_G, DEFAULT_BG_R, DEFAULT_FG_B, DEFAULT_FG_G, DEFAULT_FG_R } from "./constants";

export function safeCodepointText(codepoint: number): string {
	if (
		!Number.isInteger(codepoint) ||
		codepoint <= 0 ||
		codepoint > 0x10ffff ||
		(codepoint >= 0xd800 && codepoint <= 0xdfff)
	) {
		return "";
	}
	return String.fromCodePoint(codepoint);
}

export function isDefaultBg(cell: GhosttyCell): boolean {
	return cell.bg_r === DEFAULT_BG_R && cell.bg_g === DEFAULT_BG_G && cell.bg_b === DEFAULT_BG_B;
}

export function isDefaultFg(cell: GhosttyCell): boolean {
	return cell.fg_r === DEFAULT_FG_R && cell.fg_g === DEFAULT_FG_G && cell.fg_b === DEFAULT_FG_B;
}

export function cappedBaseY(term: GhosttyTerminal, scrollbackCap: number): number {
	return Math.min(term.getScrollbackLength(), scrollbackCap);
}

/** Cells of the presented viewport row (history when scrolled up, else active grid). */
export function presentedRowCells(
	term: GhosttyTerminal,
	viewportY: number,
	row: number,
	rows: number,
	scrollbackCap: number,
): GhosttyCell[] | null {
	const index = viewportY + row;
	const capped = cappedBaseY(term, scrollbackCap);
	if (index < capped) {
		return term.getScrollbackLine(term.getScrollbackLength() - capped + index);
	}
	const activeRow = index - capped;
	if (activeRow < 0 || activeRow >= rows) return null;
	return term.getLine(activeRow);
}

/** Reconstruct an active-grid row's text from a flat viewport cell array. */
export function activeRowText(term: GhosttyTerminal, cells: GhosttyCell[], row: number, columns: number): string {
	let text = "";
	const base = row * columns;
	for (let col = 0; col < columns; col++) {
		const cell = cells[base + col];
		if (!cell || cell.width === 0) continue; // wide-char trailing spacer
		if (cell.codepoint === 0) {
			text += " ";
		} else {
			text += cell.grapheme_len > 0 ? term.getGraphemeString(row, col) : safeCodepointText(cell.codepoint);
		}
	}
	return text.replace(/\s+$/u, "");
}

/** Reconstruct a scrollback-history row's text by line offset (0 = oldest). */
export function historyRowText(term: GhosttyTerminal, historyTextCache: string[], offset: number): string {
	const cached = historyTextCache[offset];
	if (cached !== undefined) return cached;
	const cells = term.getScrollbackLine(offset);
	if (!cells) return "";
	let text = "";
	for (let col = 0; col < cells.length; col++) {
		const cell = cells[col];
		if (!cell || cell.width === 0) continue;
		if (cell.codepoint === 0) {
			text += " ";
		} else {
			text +=
				cell.grapheme_len > 0 ? term.getScrollbackGraphemeString(offset, col) : safeCodepointText(cell.codepoint);
		}
	}
	text = text.replace(/\s+$/u, "");
	historyTextCache[offset] = text;
	return text;
}

/** Grid row text with minimal background-run SGR, for log compaction. */
export function syntheticGridRow(term: GhosttyTerminal, row: number): string {
	const cells = term.getLine(row);
	if (!cells) return "";
	let out = "";
	let currentBg = -1; // -1 = default
	for (let col = 0; col < cells.length; col++) {
		const cell = cells[col];
		if (!cell || cell.width === 0) continue;
		const bg = isDefaultBg(cell) ? -1 : (cell.bg_r << 16) | (cell.bg_g << 8) | cell.bg_b;
		if (bg !== currentBg) {
			out += bg === -1 ? "\x1b[49m" : `\x1b[48;2;${cell.bg_r};${cell.bg_g};${cell.bg_b}m`;
			currentBg = bg;
		}
		if (cell.codepoint === 0) {
			out += " ";
		} else {
			out += cell.grapheme_len > 0 ? term.getGraphemeString(row, col) : safeCodepointText(cell.codepoint);
		}
	}
	return `${out}\x1b[0m`;
}
