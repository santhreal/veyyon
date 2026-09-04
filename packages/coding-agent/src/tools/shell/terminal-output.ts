/**
 * How a virtual terminal's screen is read out of xterm.
 *
 * The rows leave here as the program wrote them: the text it printed and the SGR sequences it chose,
 * with nothing else. What a reader eventually sees of them is the host's, which for the terminal is
 * `src/modes/terminal/draw/terminal-row.ts`.
 */

import { SGR_RESET } from "@veyyon/utils/ansi";
import type { Terminal as XtermTerminal } from "@xterm/headless";

interface TerminalCell {
	getChars(): string;
	getWidth(): number;
	getFgColor(): number;
	getBgColor(): number;
	isBold(): number;
	isDim(): number;
	isItalic(): number;
	isUnderline(): number;
	isInverse(): number;
	isStrikethrough(): number;
	isOverline(): number;
	isFgRGB(): boolean;
	isBgRGB(): boolean;
	isFgPalette(): boolean;
	isBgPalette(): boolean;
}

function addColor(codes: number[], cell: TerminalCell, foreground: boolean): void {
	const rgb = foreground ? cell.isFgRGB() : cell.isBgRGB();
	const palette = foreground ? cell.isFgPalette() : cell.isBgPalette();
	if (!rgb && !palette) return;

	const color = foreground ? cell.getFgColor() : cell.getBgColor();
	codes.push(foreground ? 38 : 48);
	if (rgb) {
		codes.push(2, (color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff);
	} else {
		codes.push(5, color);
	}
}

function cellStyle(cell: TerminalCell): string {
	const codes: number[] = [];
	if (cell.isBold() !== 0) codes.push(1);
	if (cell.isDim() !== 0) codes.push(2);
	if (cell.isItalic() !== 0) codes.push(3);
	if (cell.isUnderline() !== 0) codes.push(4);
	if (cell.isInverse() !== 0) codes.push(7);
	if (cell.isStrikethrough() !== 0) codes.push(9);
	if (cell.isOverline() !== 0) codes.push(53);
	addColor(codes, cell, true);
	addColor(codes, cell, false);
	return codes.length > 0 ? `\x1b[${codes.join(";")}m` : "";
}

/** Reads terminal screen rows as the text and the SGR styles the program itself wrote. */
export function readTerminalRows(terminal: XtermTerminal, startRow: number, rowCount: number): string[] {
	const buffer = terminal.buffer.active;
	const reusableCell = buffer.getNullCell();
	const rows: string[] = [];
	const endRow = Math.min(buffer.length, Math.max(0, startRow) + Math.max(0, rowCount));

	for (let row = Math.max(0, startRow); row < endRow; row++) {
		const line = buffer.getLine(row);
		if (!line) {
			rows.push("");
			continue;
		}

		const cells: Array<{ chars: string; style: string }> = [];
		let lastContent = -1;
		for (let column = 0; column < line.length; ) {
			const cell = line.getCell(column, reusableCell);
			if (!cell) break;
			const chars = cell.getChars();
			const width = Math.max(1, cell.getWidth());
			cells.push({ chars: chars || " ", style: cellStyle(cell) });
			if (chars && chars !== " ") lastContent = cells.length - 1;
			column += width;
		}

		if (lastContent < 0) {
			rows.push("");
			continue;
		}

		let rendered = "";
		let previousStyle: string | undefined;
		for (let index = 0; index <= lastContent; index++) {
			const cell = cells[index]!;
			if (cell.style !== previousStyle) {
				rendered += `${SGR_RESET}${cell.style}`;
				previousStyle = cell.style;
			}
			rendered += cell.chars;
		}
		rows.push(rendered);
	}

	return rows;
}
