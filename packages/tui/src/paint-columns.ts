import { CSI, sgrSequence } from "./ansi";
import { toHexColor } from "./motion-paint";
import { parseHexColor } from "./paint-ground";
import { getSegmenter, padding, visibleWidth } from "./utils";

export interface ColumnPaint {
	col: number;
	background: string | undefined;
	past: boolean;
}

export type ColumnPainter = (column: ColumnPaint) => string | undefined;

export interface ColumnWindow {
	start: number;
	end: number;
}

const SGR = sgrSequence("g");

function parseSgrInt(s: string, start: number, len: number): number {
	let n = 0;
	for (let k = 0; k < len; k++) {
		const c = s.charCodeAt(start + k);
		if (c < 48 || c > 57) return -1;
		n = n * 10 + (c - 48);
	}
	return n;
}

function substrEq(s: string, start: number, len: number, lit: string): boolean {
	if (len !== lit.length) return false;
	for (let k = 0; k < len; k++) {
		if (s.charCodeAt(start + k) !== lit.charCodeAt(k)) return false;
	}
	return true;
}

function substrStartsWith(s: string, start: number, len: number, lit: string): boolean {
	if (len < lit.length) return false;
	for (let k = 0; k < lit.length; k++) {
		if (s.charCodeAt(start + k) !== lit.charCodeAt(k)) return false;
	}
	return true;
}

function trackBackground(current: string | undefined, params: string): string | undefined {
	let background = current;
	let i = 0;
	const n = params.length;
	while (i < n) {
		let j = i;
		while (j < n && params.charCodeAt(j) !== 0x3b) j++;
		const tokLen = j - i;
		if (substrEq(params, i, tokLen, "0") || tokLen === 0) background = undefined;
		else if (substrEq(params, i, tokLen, "49")) background = undefined;
		else if (substrEq(params, i, tokLen, "48")) {
			const modeStart = j + 1;
			let modeEnd = modeStart;
			while (modeEnd < n && params.charCodeAt(modeEnd) !== 0x3b) modeEnd++;
			const modeLen = modeEnd - modeStart;
			if (substrEq(params, modeStart, modeLen, "2")) {
				const p = modeEnd + 1;
				let rEnd = p;
				while (rEnd < n && params.charCodeAt(rEnd) !== 0x3b) rEnd++;
				const gStart = rEnd + 1;
				let gEnd = gStart;
				while (gEnd < n && params.charCodeAt(gEnd) !== 0x3b) gEnd++;
				const bStart = gEnd + 1;
				let bEnd = bStart;
				while (bEnd < n && params.charCodeAt(bEnd) !== 0x3b) bEnd++;
				const r = parseSgrInt(params, p, rEnd - p);
				const g = parseSgrInt(params, gStart, gEnd - gStart);
				const b = parseSgrInt(params, bStart, bEnd - bStart);
				background = r >= 0 && g >= 0 && b >= 0 ? toHexColor(r, g, b) : undefined;
				i = bEnd;
			} else if (substrEq(params, modeStart, modeLen, "5")) {
				background = undefined;
				i += 2;
			}
		} else if (substrStartsWith(params, i, tokLen, "48:")) {
			let ti = 3; // skip "48:"
			let partIdx = 0;
			let mode2 = false;
			let rVal = -1;
			let gVal = -1;
			let bVal = -1;
			let partCount = 1; // "48" is part 0
			while (ti <= tokLen) {
				let pe = ti;
				while (pe < tokLen && params.charCodeAt(i + pe) !== 0x3a) pe++;
				const plen = pe - ti;
				if (plen > 0) {
					partCount++;
					if (partIdx === 1) {
						mode2 = params.charCodeAt(i + ti) === 0x32 && plen === 1;
					} else if (partIdx >= 4) {
						const v = parseSgrInt(params, i + ti, plen);
						if (rVal < 0) rVal = v;
						else if (gVal < 0) gVal = v;
						else bVal = v;
					}
					partIdx++;
				}
				ti = pe + 1;
			}
			background =
				mode2 && partCount >= 5 && rVal >= 0 && gVal >= 0 && bVal >= 0 ? toHexColor(rVal, gVal, bVal) : undefined;
		}
	}
	return background;
}

function touchesBackground(params: string): boolean {
	if (params === "") return true;
	let i = 0;
	const n = params.length;
	while (i < n) {
		let j = i;
		while (j < n && params.charCodeAt(j) !== 0x3b) j++;
		const tokLen = j - i;
		if (
			tokLen === 0 ||
			substrEq(params, i, tokLen, "0") ||
			substrEq(params, i, tokLen, "49") ||
			substrEq(params, i, tokLen, "48")
		)
			return true;
		if (substrStartsWith(params, i, tokLen, "48:")) return true;
		const value = parseSgrInt(params, i, j - i);
		if (value >= 0 && ((value >= 40 && value <= 47) || (value >= 100 && value <= 107))) return true;
		i = j + 1;
	}
	return false;
}

function bgSequence(hex: string): string {
	const rgb = parseHexColor(hex);
	if (!rgb) return "";
	return `${CSI}48;2;${rgb.r};${rgb.g};${rgb.b}m`;
}

export function paintLineBackground(
	line: string,
	width: number,
	painter: ColumnPainter,
	window?: ColumnWindow,
): string {
	const first = window === undefined ? 0 : Math.max(0, window.start);
	const last = window === undefined ? width : Math.min(width, window.end);
	const content = visibleWidth(line);
	const padded = content < last ? line + padding(last - content) : line;

	let out = "";
	let col = 0;
	let componentBg: string | undefined;
	let paintedBg: string | undefined;
	let index = 0;

	const emitCell = (text: string, cellWidth: number): void => {
		const inWindow = col >= first && col < last;
		const wanted = inWindow ? painter({ col, background: componentBg, past: col >= content }) : undefined;
		const target = wanted ?? componentBg;
		if (target !== paintedBg) {
			out += target === undefined ? `${CSI}49m` : bgSequence(target);
			paintedBg = target;
		}
		out += text;
		col += cellWidth;
	};

	SGR.lastIndex = 0;
	for (let match = SGR.exec(padded); match !== null; match = SGR.exec(padded)) {
		emitText(padded.slice(index, match.index), emitCell);
		const params = match[1] ?? "";
		componentBg = trackBackground(componentBg, params);
		out += match[0];
		if (touchesBackground(params)) paintedBg = componentBg;
		index = match.index + match[0].length;
	}
	emitText(padded.slice(index), emitCell);

	if (paintedBg !== undefined) out += `${CSI}49m`;
	return out;
}

function emitText(text: string, emitCell: (text: string, width: number) => void): void {
	if (text === "") return;
	for (const { segment } of getSegmenter().segment(text)) {
		emitCell(segment, visibleWidth(segment));
	}
}

export function paintBlockBackground(
	lines: readonly string[],
	width: number,
	painter: (row: number) => ColumnPainter | null,
	window?: ColumnWindow,
): string[] {
	const result = new Array<string>(lines.length);
	for (let li = 0; li < lines.length; li++) {
		const columnPainter = painter(li);
		result[li] = columnPainter === null ? lines[li]! : paintLineBackground(lines[li]!, width, columnPainter, window);
	}
	return result;
}
