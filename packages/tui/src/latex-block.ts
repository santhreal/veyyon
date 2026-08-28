import { latexToUnicode } from "./latex-to-unicode";
import { clamp, padding, visibleWidth } from "./utils";

interface Box {
	lines: string[];
	baseline: number;
	width: number;
}

export type CellAlign = "l" | "c" | "r";

export const BAR = "─";
export const FRAC_COMMANDS: Record<string, true> = { frac: true, dfrac: true, tfrac: true, cfrac: true };
export const BINOM_COMMANDS: Record<string, true> = { binom: true, dbinom: true, tbinom: true };

export const DISPLAY_ROW_ENVIRONMENTS: Record<string, true> = {
	equation: true,
	eqnarray: true,
	align: true,
	aligned: true,
	alignat: true,
	alignedat: true,
	flalign: true,
	split: true,
	gather: true,
	gathered: true,
	gatheredat: true,
	multline: true,
	displaymath: true,
	math: true,
};

export const GRID_ENVIRONMENTS: Record<string, readonly [string, string]> = {
	matrix: ["", ""],
	smallmatrix: ["", ""],
	array: ["", ""],
	pmatrix: ["(", ")"],
	bmatrix: ["[", "]"],
	Bmatrix: ["{", "}"],
	vmatrix: ["|", "|"],
	Vmatrix: ["‖", "‖"],
	cases: ["{", ""],
	dcases: ["{", ""],
	rcases: ["", "}"],
	drcases: ["", "}"],
};

export const LIMIT_OPERATORS: Record<string, true> = {
	sum: true,
	prod: true,
	coprod: true,
	bigcup: true,
	bigcap: true,
	bigsqcup: true,
	bigvee: true,
	bigwedge: true,
	bigoplus: true,
	bigotimes: true,
	bigodot: true,
	biguplus: true,
	lim: true,
	limsup: true,
	liminf: true,
	projlim: true,
	injlim: true,
	varlimsup: true,
	varliminf: true,
	varprojlim: true,
	varinjlim: true,
	max: true,
	min: true,
	sup: true,
	inf: true,
	det: true,
	gcd: true,
	Pr: true,
	argmax: true,
	argmin: true,
};

export const INTEGRAL_OPERATORS: Record<string, true> = {
	int: true,
	iint: true,
	iiint: true,
	iiiint: true,
	oint: true,
	oiint: true,
	oiiint: true,
	idotsint: true,
	intop: true,
	smallint: true,
};

export interface DelimPieces {
	only: string;
	top: string;
	mid: string;
	bot: string;
	axis?: string;
}

export const DELIM_PIECES: Record<string, DelimPieces> = {
	"(": { only: "(", top: "⎛", mid: "⎜", bot: "⎝" },
	")": { only: ")", top: "⎞", mid: "⎟", bot: "⎠" },
	"[": { only: "[", top: "⎡", mid: "⎢", bot: "⎣" },
	"]": { only: "]", top: "⎤", mid: "⎥", bot: "⎦" },
	"{": { only: "{", top: "⎧", mid: "⎪", bot: "⎩", axis: "⎨" },
	"}": { only: "}", top: "⎫", mid: "⎪", bot: "⎭", axis: "⎬" },
	"|": { only: "|", top: "│", mid: "│", bot: "│" },
	"‖": { only: "‖", top: "║", mid: "║", bot: "║" },
	"⌈": { only: "⌈", top: "⎡", mid: "⎢", bot: "⎢" },
	"⌉": { only: "⌉", top: "⎤", mid: "⎥", bot: "⎥" },
	"⌊": { only: "⌊", top: "⎢", mid: "⎢", bot: "⎣" },
	"⌋": { only: "⌋", top: "⎥", mid: "⎥", bot: "⎦" },
};

export const DELIM_KEYS: Record<string, string> = {
	"(": "(",
	")": ")",
	"[": "[",
	"]": "]",
	"\\{": "{",
	"\\}": "}",
	"\\lbrace": "{",
	"\\rbrace": "}",
	"|": "|",
	"\\vert": "|",
	"\\lvert": "|",
	"\\rvert": "|",
	"\\|": "‖",
	"\\Vert": "‖",
	"\\lVert": "‖",
	"\\rVert": "‖",
	"\\langle": "⟨",
	"\\rangle": "⟩",
	"<": "⟨",
	">": "⟩",
	"\\lceil": "⌈",
	"\\rceil": "⌉",
	"\\lfloor": "⌊",
	"\\rfloor": "⌋",
	"\\lbrack": "[",
	"\\rbrack": "]",
	".": "",
};

export interface Ctx {
	wrap: (run: string) => string;
}

export const ROOT_CTX: Ctx = { wrap: run => run };

export function spaces(n: number): string {
	return padding(n);
}

export function padRight(line: string, width: number): string {
	return line + spaces(width - visibleWidth(line));
}

export function center(line: string, width: number): string {
	const extra = width - visibleWidth(line);
	if (extra <= 0) return line;
	const left = extra >> 1;
	return spaces(left) + line + spaces(extra - left);
}

export function textBox(text: string): Box {
	const raw = text.split("\n");
	let width = 0;
	for (let li = 0; li < raw.length; li++) width = Math.max(width, visibleWidth(raw[li]!));
	const lines = new Array<string>(raw.length);
	for (let li = 0; li < raw.length; li++) lines[li] = padRight(raw[li]!, width);
	return { lines, baseline: (raw.length - 1) >> 1, width };
}

export function padBox(b: Box, width: number, align: CellAlign): Box {
	if (b.width >= width) return b;
	const lines = new Array<string>(b.lines.length);
	for (let li = 0; li < b.lines.length; li++) {
		const line = b.lines[li]!;
		const extra = width - visibleWidth(line);
		if (align === "l") lines[li] = line + spaces(extra);
		else if (align === "r") lines[li] = spaces(extra) + line;
		else {
			const left = extra >> 1;
			lines[li] = spaces(left) + line + spaces(extra - left);
		}
	}
	return { lines, baseline: b.baseline, width };
}

export function hconcat(boxes: Box[]): Box {
	if (boxes.length === 1) return boxes[0];
	let above = 0;
	let below = 0;
	for (let bi = 0; bi < boxes.length; bi++) {
		above = Math.max(above, boxes[bi]!.baseline);
		below = Math.max(below, boxes[bi]!.lines.length - 1 - boxes[bi]!.baseline);
	}
	const height = above + below + 1;
	const lines: string[] = [];
	let width = 0;
	for (let bi = 0; bi < boxes.length; bi++) width += boxes[bi]!.width;
	for (let row = 0; row < height; row++) {
		let line = "";
		for (let bi = 0; bi < boxes.length; bi++) {
			const b = boxes[bi]!;
			const local = row - (above - b.baseline);
			line += local >= 0 && local < b.lines.length ? b.lines[local] : spaces(b.width);
		}
		lines.push(line);
	}
	return { lines, baseline: above, width };
}

export function vconcat(boxes: Box[], align: CellAlign = "l"): Box {
	if (boxes.length === 1) return boxes[0];
	let width = 0;
	for (let bi = 0; bi < boxes.length; bi++) width = Math.max(width, boxes[bi]!.width);
	const lines: string[] = [];
	for (let bi = 0; bi < boxes.length; bi++) {
		const bLines = boxes[bi]!.lines;
		for (let li = 0; li < bLines.length; li++) {
			lines.push(align === "c" ? center(bLines[li]!, width) : padRight(bLines[li]!, width));
		}
	}
	return { lines, baseline: (lines.length - 1) >> 1, width };
}

export function fracBox(num: Box, den: Box): Box {
	const width = Math.max(num.width, den.width) + 2;
	const lines: string[] = [];
	for (let i = 0; i < num.lines.length; i++) lines.push(center(num.lines[i]!, width));
	lines.push(BAR.repeat(width));
	for (let i = 0; i < den.lines.length; i++) lines.push(center(den.lines[i]!, width));
	return { lines, baseline: num.lines.length, width };
}

export function delimColumn(key: string, height: number, baseline: number): Box | null {
	if (!key) return null;
	const pieces = DELIM_PIECES[key];
	if (height <= 1) {
		const only = pieces?.only ?? key;
		return only ? { lines: [only], baseline: 0, width: visibleWidth(only) } : null;
	}
	const width = visibleWidth(pieces?.only ?? key);
	const blank = spaces(width);
	const lines: string[] = [];
	if (!pieces) {
		for (let y = 0; y < height; y++) lines.push(y === baseline ? key : blank);
		return { lines, baseline, width };
	}
	const axisRow = clamp(baseline, 1, height - 2);
	for (let y = 0; y < height; y++) {
		if (y === 0) lines.push(pieces.top);
		else if (y === height - 1) lines.push(pieces.bot);
		else if (y === axisRow && pieces.axis) lines.push(pieces.axis);
		else lines.push(pieces.mid);
	}
	return { lines, baseline, width };
}

export function delimBox(inner: Box, left: string, right: string): Box {
	const height = inner.lines.length;
	const lcol = delimColumn(left, height, inner.baseline);
	const rcol = delimColumn(right, height, inner.baseline);
	if (!lcol && !rcol) return inner;
	const pad: Box | null = height > 1 ? textBox(" ") : null;
	const parts: Box[] = [];
	if (lcol) parts.push(lcol);
	if (pad) parts.push(pad);
	parts.push(inner);
	if (pad) parts.push(pad);
	if (rcol) parts.push(rcol);
	return hconcat(parts);
}

export function binomBox(top: Box, bottom: Box): Box {
	const width = Math.max(top.width, bottom.width);
	const lines: string[] = [];
	for (let i = 0; i < top.lines.length; i++) lines.push(center(top.lines[i]!, width));
	lines.push(spaces(width));
	for (let i = 0; i < bottom.lines.length; i++) lines.push(center(bottom.lines[i]!, width));
	return delimBox({ lines, baseline: top.lines.length, width }, "(", ")");
}

export function radicalBox(inner: Box, degree: string | null): Box {
	const lines: string[] = [` ┌${BAR.repeat(inner.width + 1)}`];
	for (let y = 0; y < inner.lines.length; y++) {
		lines.push((y === inner.lines.length - 1 ? "╲│ " : " │ ") + inner.lines[y]);
	}
	const box: Box = { lines, baseline: inner.baseline + 1, width: inner.width + 3 };
	if (!degree) return box;
	const deg = latexToUnicode(`^{${degree}}`);
	return hconcat([{ lines: [deg, spaces(visibleWidth(deg))], baseline: 1, width: visibleWidth(deg) }, box]);
}

export function limitsBox(glyph: Box, sub: Box | null, sup: Box | null): Box {
	const width = Math.max(glyph.width, sub?.width ?? 0, sup?.width ?? 0);
	const lines: string[] = [];
	if (sup) for (let li = 0; li < sup.lines.length; li++) lines.push(center(sup.lines[li]!, width));
	const baseline = lines.length + glyph.baseline;
	for (let li = 0; li < glyph.lines.length; li++) lines.push(center(glyph.lines[li]!, width));
	if (sub) for (let li = 0; li < sub.lines.length; li++) lines.push(center(sub.lines[li]!, width));
	return { lines, baseline, width };
}

export function attachScripts(base: Box, sub: Box | null, sup: Box | null): Box {
	if (sub === null && sup === null) return base;
	const single = base.lines.length === 1;
	const width = Math.max(sub?.width ?? 0, sup?.width ?? 0);
	const blank = spaces(width);
	const lines: string[] = [];
	let baseline = 0;
	if (sup) {
		const lift = single ? 1 : base.baseline;
		for (let li = 0; li < sup.lines.length; li++) lines.push(padRight(sup.lines[li]!, width));
		for (let k = 0; k < lift; k++) lines.push(blank);
		baseline = lines.length - 1;
	}
	if (sub) {
		const below = base.lines.length - 1 - base.baseline - (sub.lines.length - 1);
		let drop = Math.max(below, single ? 1 : 0);
		if (sup && drop < 1) drop = 1;
		const gap = lines.length === 0 ? drop : drop - 1;
		for (let k = 0; k < gap; k++) lines.push(blank);
		for (let li = 0; li < sub.lines.length; li++) lines.push(padRight(sub.lines[li]!, width));
	}
	return hconcat([base, { lines, baseline, width }]);
}

export function gridBox(
	rows: Box[][],
	align: (col: number) => CellAlign,
	gap: (col: number) => number,
	rowGap = 0,
): Box {
	let ncols = 0;
	for (let ri = 0; ri < rows.length; ri++) ncols = Math.max(ncols, rows[ri]!.length);
	if (ncols === 0 || rows.length === 0) return textBox("");
	const widths = new Array<number>(ncols).fill(0);
	for (let ri = 0; ri < rows.length; ri++) {
		const row = rows[ri]!;
		for (let j = 0; j < row.length; j++) {
			widths[j] = Math.max(widths[j], row[j]!.width);
		}
	}
	const rowBoxes: Box[] = [];
	for (let ri = 0; ri < rows.length; ri++) {
		const row = rows[ri]!;
		if (rowGap > 0 && rowBoxes.length > 0) {
			for (let g = 0; g < rowGap; g++) rowBoxes.push({ lines: [""], baseline: 0, width: 0 });
		}
		const parts: Box[] = [];
		for (let j = 0; j < ncols; j++) {
			if (j > 0) {
				const g = gap(j);
				if (g > 0) parts.push({ lines: [spaces(g)], baseline: 0, width: g });
			}
			parts.push(padBox(row[j] ?? { lines: [""], baseline: 0, width: 0 }, widths[j], align(j)));
		}
		rowBoxes.push(hconcat(parts));
	}
	const grid = vconcat(rowBoxes);
	if (rowGap > 0 && rows.length > 1 && grid.lines.length % 2 === 0) {
		return { lines: grid.lines.concat([spaces(grid.width)]), baseline: grid.lines.length >> 1, width: grid.width };
	}
	return grid;
}

export interface Span {
	text: string;
	end: number;
}

export function readBraceGroup(src: string, i: number): Span {
	let depth = 0;
	let out = "";
	let j = i;
	for (; j < src.length; j++) {
		const c = src[j];
		if (c === "\\") {
			out += c + (src[j + 1] ?? "");
			j++;
			continue;
		}
		if (c === "{") {
			depth++;
			if (depth > 1) out += c;
			continue;
		}
		if (c === "}") {
			depth--;
			if (depth === 0) {
				j++;
				break;
			}
			out += c;
			continue;
		}
		out += c;
	}
	return { text: out, end: j };
}

export function readArg(src: string, i: number): Span {
	while (src[i] === " ") i++;
	if (i >= src.length) return { text: "", end: i };
	if (src[i] === "{") return readBraceGroup(src, i);
	if (src[i] !== "\\") return { text: src[i], end: i + 1 };
	let j = i + 1;
	let name = "";
	while (/[A-Za-z]/.test(src[j] ?? "")) {
		name += src[j];
		j++;
	}
	if (name === "begin") {
		const env = consumeEnvironment(src, i);
		if (env) return env;
	}
	if (!name) return { text: src.slice(i, i + 2), end: i + 2 }; // non-letter command (\,, \{, …)
	let end = j;
	while (src[end] === "[" || src[end] === "{") {
		if (src[end] === "{") end = readBraceGroup(src, end).end;
		else {
			const close = src.indexOf("]", end);
			end = close === -1 ? src.length : close + 1;
		}
	}
	return { text: src.slice(i, end), end };
}

export function readDelimToken(src: string, i: number): Span | null {
	while (src[i] === " ") i++;
	if (i >= src.length) return null;
	if (src[i] !== "\\") return { text: src[i], end: i + 1 };
	let j = i + 1;
	if (!/[A-Za-z]/.test(src[j] ?? "")) return { text: src.slice(i, j + 1), end: j + 1 };
	while (/[A-Za-z]/.test(src[j] ?? "")) j++;
	return { text: src.slice(i, j), end: j };
}

export function delimKey(token: string): string {
	const mapped = DELIM_KEYS[token];
	if (mapped !== undefined) return mapped;
	return token.startsWith("\\") ? latexToUnicode(token).trim() : token;
}

export interface LeftRightParts {
	left: string;
	segments: string[];
	middles: string[];
	right: string;
	end: number;
}

export function readLeftRight(src: string, start: number): LeftRightParts | null {
	const left = readDelimToken(src, start + 5);
	if (!left) return null;
	const segments: string[] = [];
	const middles: string[] = [];
	let depth = 1;
	let k = left.end;
	let segStart = k;
	while (k < src.length) {
		if (src[k] !== "\\") {
			k++;
			continue;
		}
		if (src.startsWith("\\left", k) && !/[A-Za-z]/.test(src[k + 5] ?? "")) {
			depth++;
			const tok = readDelimToken(src, k + 5);
			k = tok ? tok.end : k + 5;
			continue;
		}
		if (src.startsWith("\\right", k) && !/[A-Za-z]/.test(src[k + 6] ?? "")) {
			depth--;
			const tok = readDelimToken(src, k + 6);
			if (depth === 0) {
				segments.push(src.slice(segStart, k));
				return { left: left.text, segments, middles, right: tok ? tok.text : ".", end: tok ? tok.end : k + 6 };
			}
			k = tok ? tok.end : k + 6;
			continue;
		}
		if (depth === 1 && src.startsWith("\\middle", k) && !/[A-Za-z]/.test(src[k + 7] ?? "")) {
			segments.push(src.slice(segStart, k));
			const tok = readDelimToken(src, k + 7);
			middles.push(tok ? tok.text : "|");
			k = segStart = tok ? tok.end : k + 7;
			continue;
		}
		k += 2; // escaped char / other command head — never a boundary
	}
	return null; // unbalanced
}

export function matchDelim(src: string, i: number, open: string, close: string): number {
	let depth = 0;
	for (let k = i; k < src.length; k++) {
		const c = src[k];
		if (c === "\\") {
			k++;
			continue;
		}
		if (c === "{") {
			k = readBraceGroup(src, k).end - 1;
			continue;
		}
		if (c === open) depth++;
		else if (c === close) {
			depth--;
			if (depth === 0) return k;
		}
	}
	return -1;
}

export interface EnvParts {
	env: string;
	bodyStart: number;
	bodyEnd: number;
	end: number;
}

export function readEnvironment(src: string, start: number): EnvParts | null {
	let i = start + 6; // past "\begin"
	while (src[i] === " ") i++;
	if (src[i] !== "{") return null;
	const nameGroup = readBraceGroup(src, i);
	let k = nameGroup.end;
	let depth = 1;
	let bodyEnd = src.length;
	while (k < src.length && depth > 0) {
		if (src.startsWith("\\begin", k)) {
			depth++;
			k += 6;
			continue;
		}
		if (src.startsWith("\\end", k)) {
			depth--;
			if (depth === 0) bodyEnd = k;
			k += 4;
			while (src[k] === " ") k++;
			if (src[k] === "{") k = readBraceGroup(src, k).end;
			if (depth === 0) break;
			continue;
		}
		k++;
	}
	return { env: nameGroup.text.trim(), bodyStart: nameGroup.end, bodyEnd, end: k };
}

export function consumeEnvironment(src: string, start: number): Span | null {
	const env = readEnvironment(src, start);
	return env ? { text: src.slice(start, env.end), end: env.end } : null;
}

export function splitRows(body: string): string[] {
	const rows: string[] = [];
	let braceDepth = 0;
	let envDepth = 0;
	let last = 0;
	let i = 0;
	while (i < body.length) {
		if (body.startsWith("\\begin", i)) {
			envDepth++;
			i += 6;
			continue;
		}
		if (body.startsWith("\\end", i)) {
			envDepth--;
			i += 4;
			continue;
		}
		const c = body[i];
		if (c === "\\") {
			if (body[i + 1] === "\\" && braceDepth === 0 && envDepth === 0) {
				rows.push(body.slice(last, i));
				i += 2;
				while (body[i] === " ") i++;
				if (body[i] === "[") {
					const close = body.indexOf("]", i);
					i = close === -1 ? body.length : close + 1;
				}
				last = i;
				continue;
			}
			i += 2; // skip escaped char / second backslash so `\{`/`\\` never skew depth
			continue;
		}
		if (c === "{") braceDepth++;
		else if (c === "}") braceDepth--;
		i++;
	}
	rows.push(body.slice(last));
	return rows;
}

// circular import: latexToBlock lives in helpers
export { latexToBlock } from "./latex-block-helpers";
