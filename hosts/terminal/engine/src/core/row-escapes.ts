/**
 * Escape scanning over a prepared row: where an escape sequence ends, whether it draws cells, the width of
 * a row that holds only ASCII and zero-width escapes, and the row without its erasable blank tail.
 */
import { sgrEnd } from "@veyyon/utils/ansi";
import { SgrState } from "@veyyon/utils/sgr";

export function ansiSequenceEnd(line: string, start: number): number {
	const next = line.charCodeAt(start + 1);
	if (next === 0x5b) return csiEnd(line, start + 2);
	if (next === 0x5d) return oscEnd(line, start + 2);
	return start + 2 <= line.length ? start + 2 : -1;
}

/** The index after the CSI whose parameters start at `from`: past its final byte in 0x40-0x7E, or -1 when unterminated. */
function csiEnd(line: string, from: number): number {
	for (let i = from; i < line.length; i++) {
		const final = line.charCodeAt(i);
		if (final >= 0x40 && final <= 0x7e) return i + 1;
	}
	return -1;
}

/** The index after the OSC whose payload starts at `from`: past its BEL or ST (ESC \), or -1 when unterminated. */
function oscEnd(line: string, from: number): number {
	for (let i = from; i < line.length; i++) {
		const osc = line.charCodeAt(i);
		if (osc === 0x07) return i + 1;
		if (osc === 0x1b && line.charCodeAt(i + 1) === 0x5c) return i + 2;
	}
	return -1;
}

export function ansiSequenceHasVisiblePayload(line: string, start: number): boolean {
	// OSC 66 (`\x1b]66;META;TEXT\x1b\\`) carries visible cells inside the payload.
	return (
		line.charCodeAt(start + 1) === 0x5d &&
		line.charCodeAt(start + 2) === 0x36 &&
		line.charCodeAt(start + 3) === 0x36 &&
		line.charCodeAt(start + 4) === 0x3b
	);
}

/** The index after the zero-width CSI or OSC at `start`, or -1 for any other escape and for an unterminated one. */
function invisibleEscapeEnd(line: string, start: number): number {
	if (ansiSequenceHasVisiblePayload(line, start)) return -1;
	const next = line.charCodeAt(start + 1);
	if (next !== 0x5b && next !== 0x5d) return -1;
	return ansiSequenceEnd(line, start);
}

export function ansiAsciiLineWidth(line: string, maxWidth: number): number | undefined {
	let col = 0;
	for (let i = 0; i < line.length; ) {
		const code = line.charCodeAt(i);
		if (code === 0x1b) {
			const end = invisibleEscapeEnd(line, i);
			if (end < 0) return undefined;
			i = end;
			continue;
		}
		if (code < 0x20 || code > 0x7e) return undefined;
		col++;
		if (col > maxWidth) return col;
		i++;
	}
	return col;
}

const trailingSgr = new SgrState();

/**
 * `line` without the spaces after its last drawn cell, for a painter that erases the row: a space under
 * no attribute that marks a blank ({@link SgrState.marksBlank}) draws what an erased cell draws. The
 * escapes among those spaces stay in order, so the attributes open at the end of the row are the same.
 * A row holding an escape other than a CSI or a zero-width OSC is returned as is.
 *
 * Components pad every row to the terminal width, so a repainted row was mostly spaces: the working
 * line's spinner frame was 344 bytes, 166 of them the padding after its message.
 */
export function trimErasableTrailingSpaces(line: string): string {
	trailingSgr.reset();
	let marksBlank = false;
	let blankFrom = -1;
	for (let i = 0; i < line.length; ) {
		const code = line.charCodeAt(i);
		if (code === 0x1b) {
			const end = invisibleEscapeEnd(line, i);
			if (end < 0) return line;
			const sgr = sgrEnd(line, i);
			if (sgr !== -1) {
				trailingSgr.apply(line, i, sgr);
				marksBlank = trailingSgr.marksBlank;
			}
			i = end;
			continue;
		}
		if (code !== 0x20 || marksBlank) blankFrom = -1;
		else if (blankFrom === -1) blankFrom = i;
		i++;
	}
	if (blankFrom === -1) return line;
	let row = line.slice(0, blankFrom);
	for (let i = blankFrom; i < line.length; ) {
		if (line.charCodeAt(i) === 0x20) {
			i++;
			continue;
		}
		const end = invisibleEscapeEnd(line, i);
		row += line.slice(i, end);
		i = end;
	}
	return row;
}
