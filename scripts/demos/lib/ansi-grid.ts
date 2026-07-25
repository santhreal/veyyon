/**
 * Turn styled terminal output into a grid of cells that can be drawn.
 *
 * This is the first half of a render proof: the ANSI a component actually produced
 * is decoded into "what colour is each cell, and what is written in it", with no
 * terminal involved. That matters because the failures worth proving are exactly
 * the ones a terminal capture cannot show. A background fill is a real, coloured
 * cell here whether or not the viewing terminal's own ground happens to match it,
 * so a block of explicit dark background is visibly a block, instead of vanishing
 * into a black terminal and reappearing as a slab on a grey one.
 *
 * Only the SGR subset veyyon emits is decoded. Anything else in the stream is
 * skipped rather than guessed at, and cursor movement is deliberately NOT
 * interpreted: a proof renders the bytes a component returned from `render(width)`,
 * which is plain lines, and a stream that repositions the cursor is a live-screen
 * capture that this tool has no business pretending to replay.
 */

/** A resolved colour, or `undefined` meaning "the terminal's default". */
export type Rgb = readonly [number, number, number];

export interface Cell {
	/** The grapheme in this cell. A space for an empty cell. */
	char: string;
	fg: Rgb | undefined;
	bg: Rgb | undefined;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	/**
	 * Set by SGR 7. Left as a flag rather than applied here because swapping
	 * foreground and background needs the DEFAULT colours, which belong to the
	 * ground the proof is drawn against, not to the stream.
	 */
	reverse: boolean;
	/**
	 * True for the second cell of a double-width grapheme. The glyph is drawn from
	 * the first cell and this one only carries its background, so a wide character
	 * cannot be drawn twice or have its right half painted with the ground.
	 */
	continuation: boolean;
}

export interface Grid {
	width: number;
	height: number;
	/** Row-major, `height` rows of exactly `width` cells. */
	rows: Cell[][];
}

/** The 16 ANSI colours, as xterm renders them. */
const BASE_16: readonly Rgb[] = [
	[0, 0, 0],
	[205, 0, 0],
	[0, 205, 0],
	[205, 205, 0],
	[0, 0, 238],
	[205, 0, 205],
	[0, 205, 205],
	[229, 229, 229],
	[127, 127, 127],
	[255, 0, 0],
	[0, 255, 0],
	[255, 255, 0],
	[92, 92, 255],
	[255, 0, 255],
	[0, 255, 255],
	[255, 255, 255],
];

/** The 6 levels the xterm 256-colour cube steps through. */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

/** Resolve an xterm 256-colour index the way a terminal does. */
export function palette256(index: number): Rgb {
	if (index < 16) return BASE_16[index];
	if (index < 232) {
		const n = index - 16;
		return [CUBE_LEVELS[Math.floor(n / 36) % 6], CUBE_LEVELS[Math.floor(n / 6) % 6], CUBE_LEVELS[n % 6]];
	}
	const level = 8 + (index - 232) * 10;
	return [level, level, level];
}

interface Style {
	fg: Rgb | undefined;
	bg: Rgb | undefined;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	reverse: boolean;
}

function resetStyle(): Style {
	return { fg: undefined, bg: undefined, bold: false, dim: false, italic: false, underline: false, reverse: false };
}

/**
 * Apply one SGR sequence's parameters to a style.
 *
 * Exported for its own tests: this is where a proof would silently start lying if
 * it mishandled a code, and "the image looked plausible" is not a check.
 */
export function applySgr(style: Style, params: number[]): Style {
	const next = { ...style };
	for (let i = 0; i < params.length; i++) {
		const code = params[i];
		switch (code) {
			case 0:
				Object.assign(next, resetStyle());
				break;
			case 1:
				next.bold = true;
				break;
			case 2:
				next.dim = true;
				break;
			case 3:
				next.italic = true;
				break;
			case 4:
				next.underline = true;
				break;
			case 7:
				next.reverse = true;
				break;
			case 22:
				next.bold = false;
				next.dim = false;
				break;
			case 23:
				next.italic = false;
				break;
			case 24:
				next.underline = false;
				break;
			case 27:
				next.reverse = false;
				break;
			case 39:
				next.fg = undefined;
				break;
			case 49:
				next.bg = undefined;
				break;
			case 38:
			case 48: {
				const target = code === 38 ? "fg" : "bg";
				if (params[i + 1] === 2) {
					next[target] = [params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0];
					i += 4;
				} else if (params[i + 1] === 5) {
					next[target] = palette256(params[i + 2] ?? 0);
					i += 2;
				}
				break;
			}
			default:
				if (code >= 30 && code <= 37) next.fg = BASE_16[code - 30];
				else if (code >= 90 && code <= 97) next.fg = BASE_16[code - 90 + 8];
				else if (code >= 40 && code <= 47) next.bg = BASE_16[code - 40];
				else if (code >= 100 && code <= 107) next.bg = BASE_16[code - 100 + 8];
				break;
		}
	}
	return next;
}

function blankCell(style: Style): Cell {
	return {
		char: " ",
		fg: style.fg,
		bg: style.bg,
		bold: style.bold,
		dim: style.dim,
		italic: style.italic,
		underline: style.underline,
		reverse: style.reverse,
		continuation: false,
	};
}

/** Cell width of a grapheme: 2 for the double-width ranges, 0 for combining marks. */
export function cellWidth(grapheme: string): number {
	const code = grapheme.codePointAt(0);
	if (code === undefined) return 0;
	// Combining marks and variation selectors ride along with the previous cell.
	if ((code >= 0x0300 && code <= 0x036f) || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
	if (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1f64f) ||
		(code >= 0x1f900 && code <= 0x1f9ff)
	) {
		return 2;
	}
	return 1;
}

const CSI_FINAL = /[@-~]/;

/**
 * Decode styled lines into a fixed grid.
 *
 * Every row is padded to `width` with cells carrying the DEFAULT background, not
 * the style in force at the end of the line. That is what a terminal does with a
 * line that simply ends, and it is the distinction that makes a proof useful: a
 * component that means to fill its whole width has to say so, and one that stops
 * early shows the ground.
 */
export function ansiToGrid(lines: string[], width: number): Grid {
	const rows: Cell[][] = [];
	for (const line of lines) {
		let style = resetStyle();
		const row: Cell[] = [];
		const graphemes = [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(line)].map(s => s.segment);
		for (let i = 0; i < graphemes.length; i++) {
			const g = graphemes[i];
			if (g === "\x1b") {
				// Consume the escape sequence: CSI ... final byte, or OSC ... BEL/ST.
				const rest = graphemes.slice(i + 1);
				if (rest[0] === "[") {
					let j = 1;
					let raw = "";
					while (j < rest.length && !CSI_FINAL.test(rest[j])) {
						raw += rest[j];
						j++;
					}
					const final = rest[j];
					if (final === "m") {
						const params = raw
							.split(";")
							.map(part => (part === "" ? 0 : Number.parseInt(part, 10)))
							.map(value => (Number.isFinite(value) ? value : 0));
						style = applySgr(style, params);
					}
					i += j + 1;
					continue;
				}
				if (rest[0] === "]") {
					let j = 1;
					while (j < rest.length && rest[j] !== "\x07" && !(rest[j] === "\x1b" && rest[j + 1] === "\\")) j++;
					i += rest[j] === "\x1b" ? j + 2 : j + 1;
					continue;
				}
				i += 1;
				continue;
			}
			const w = cellWidth(g);
			if (w === 0) {
				// Attach to the previous cell so a combining mark is not a cell of its own.
				const last = row[row.length - 1];
				if (last) last.char += g;
				continue;
			}
			row.push({ ...blankCell(style), char: g });
			if (w === 2) row.push({ ...blankCell(style), continuation: true });
		}
		while (row.length < width) row.push(blankCell(resetStyle()));
		rows.push(row.slice(0, width));
	}
	return { width, height: rows.length, rows };
}
