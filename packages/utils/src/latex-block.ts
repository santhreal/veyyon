// Two-dimensional layout engine for *display* LaTeX math.
//
//              ┌─────────       n         ⎛  a+b  ⎞²
//        −b ± ╲│ b² − 4ac       ∑   xᵢ    ⎜ ───── ⎟     ⎡ 1  2 ⎤
//   x = ──────────────────    i=0         ⎝   c   ⎠     ⎣ 3  4 ⎦
//               2a
//
// Only display blocks (`$$…$$`, `\[…\]`) use this; inline `$…$` stays single-line
// via `latexToUnicode` (`½`, `(a+b)/c`). The engine lays out a `Box` tree —
// rectangles of padded lines with a `baseline` row — and knows how to stack
// fractions and `\binom`, stretch delimiters (`\left…\right`, tall bare parens,
// matrix brackets), render matrix/cases/array environments as baseline-aligned
// grids, place big-operator limits (`\sum`, `\lim`, `\int\limits`) above and
// below the symbol, draw radicals, raise/lower block scripts, and
// align `&` columns in `align`-family environments. Flat runs — symbols, fonts,
// colors, inline scripts — are delegated to `latexToUnicode`.
//
// The 2-D layout approach (stretchy delimiter piecing, stacked operator limits,
// baseline-aligned matrix grids, drawn radicals, block scripts) is modeled on
// txm — Terminal TeX Math — by @thatmagicalcat
// (https://github.com/thatmagicalcat/txm, MIT/Apache-2.0), reimplemented from
// scratch here on this module's ANSI-aware Box model.

import { isAsciiLetter, latexColorScope, latexToUnicode, MATH_FONT_COMMANDS } from "./latex-unicode";
import { clamp } from "./math";
import { visibleWidth } from "./width";

/**
 * A rectangular block of rendered text. Every entry in `lines` is padded to
 * exactly `width` visible columns; `baseline` is the row that aligns with the
 * surrounding text when boxes are placed side by side (e.g. the fraction bar).
 */
interface Box {
	lines: string[];
	baseline: number;
	width: number;
}

type CellAlign = "l" | "c" | "r";

const BAR = "─";
const FRAC_COMMANDS: ReadonlySet<string> = new Set(["frac", "dfrac", "tfrac", "cfrac"]);
const BINOM_COMMANDS: ReadonlySet<string> = new Set(["binom", "dbinom", "tbinom"]);

// Display "wrapper" environments whose body is an expression (possibly with `\\`
// row breaks and `&` alignment). Their rows are parsed so fractions inside stack
// and `&` columns align.
const DISPLAY_ROW_ENVIRONMENTS: ReadonlySet<string> = new Set([
	"equation",
	"eqnarray",
	"align",
	"aligned",
	"alignat",
	"alignedat",
	"flalign",
	"split",
	"gather",
	"gathered",
	"gatheredat",
	"multline",
	"displaymath",
	"math",
]);

// Environments laid out as 2-D grids of parsed cells: [open, close] delimiter.
const GRID_ENVIRONMENTS: ReadonlyMap<string, readonly [string, string]> = new Map(
	Object.entries<readonly [string, string]>({
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
	}),
);

// Operators whose display-style scripts stack above/below the symbol.
const LIMIT_OPERATORS: ReadonlySet<string> = new Set([
	"sum",
	"prod",
	"coprod",
	"bigcup",
	"bigcap",
	"bigsqcup",
	"bigvee",
	"bigwedge",
	"bigoplus",
	"bigotimes",
	"bigodot",
	"biguplus",
	"lim",
	"limsup",
	"liminf",
	"projlim",
	"injlim",
	"varlimsup",
	"varliminf",
	"varprojlim",
	"varinjlim",
	"max",
	"min",
	"sup",
	"inf",
	"det",
	"gcd",
	"Pr",
	"argmax",
	"argmin",
]);

// Integral-family operators: scripts stay beside the symbol (LaTeX display
// convention) unless an explicit `\limits` follows.
const INTEGRAL_OPERATORS: ReadonlySet<string> = new Set([
	"int",
	"iint",
	"iiint",
	"iiiint",
	"oint",
	"oiint",
	"oiiint",
	"idotsint",
	"intop",
	"smallint",
]);

// Vertical delimiter piece characters: `only` for single-line content, then
// top/mid/bot columns for stretched forms; `axis` replaces `mid` at the
// baseline row (the brace point).
interface DelimPieces {
	only: string;
	top: string;
	mid: string;
	bot: string;
	axis?: string;
}

const DELIM_PIECES: ReadonlyMap<string, DelimPieces> = new Map(
	Object.entries<DelimPieces>({
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
	}),
);

// `\left`/`\right`/`\middle` delimiter token → piece-table key. Unknown tokens
// fall back to `latexToUnicode` and render at the baseline row only.
const DELIM_KEYS: ReadonlyMap<string, string> = new Map(
	Object.entries({
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
	}),
);

/**
 * Inline-run conversion context. `wrap` re-applies the scoped commands (math
 * fonts, colors) active at this point in the parse, so each flat run handed to
 * `latexToUnicode` renders with the same styling it would have had in one piece.
 */
interface Ctx {
	wrap: (run: string) => string;
}

const ROOT_CTX: Ctx = { wrap: run => run };

function spaces(n: number): string {
	return n > 0 ? " ".repeat(n) : "";
}

/** Pad `line` on the right to `width` visible columns. */
function padRight(line: string, width: number): string {
	return line + spaces(width - visibleWidth(line));
}

/** Pad `line` symmetrically (left-biased) to `width` visible columns. */
function center(line: string, width: number): string {
	const extra = width - visibleWidth(line);
	if (extra <= 0) return line;
	const left = extra >> 1;
	return spaces(left) + line + spaces(extra - left);
}

/** A single rendered string (possibly multi-line) as a baseline-centered box. */
function textBox(text: string): Box {
	const raw = text.split("\n");
	let width = 0;
	for (const line of raw) width = Math.max(width, visibleWidth(line));
	return { lines: raw.map(line => padRight(line, width)), baseline: (raw.length - 1) >> 1, width };
}

/** Pad every line of `b` to `width` per `align`, keeping the baseline. */
function padBox(b: Box, width: number, align: CellAlign): Box {
	if (b.width >= width) return b;
	const lines = b.lines.map(line => {
		const extra = width - visibleWidth(line);
		if (align === "l") return line + spaces(extra);
		if (align === "r") return spaces(extra) + line;
		const left = extra >> 1;
		return spaces(left) + line + spaces(extra - left);
	});
	return { lines, baseline: b.baseline, width };
}

/** Place boxes side by side, aligning their baselines. */
function hconcat(boxes: Box[]): Box {
	if (boxes.length === 1) return boxes[0];
	let above = 0;
	let below = 0;
	for (const b of boxes) {
		above = Math.max(above, b.baseline);
		below = Math.max(below, b.lines.length - 1 - b.baseline);
	}
	const height = above + below + 1;
	const lines: string[] = [];
	let width = 0;
	for (const b of boxes) width += b.width;
	for (let row = 0; row < height; row++) {
		let line = "";
		for (const b of boxes) {
			const local = row - (above - b.baseline);
			line += local >= 0 && local < b.lines.length ? b.lines[local] : spaces(b.width);
		}
		lines.push(line);
	}
	return { lines, baseline: above, width };
}

/** Stack boxes vertically, e.g. the rows of an aligned block. */
function vconcat(boxes: Box[], align: CellAlign = "l"): Box {
	if (boxes.length === 1) return boxes[0];
	let width = 0;
	for (const b of boxes) width = Math.max(width, b.width);
	const lines: string[] = [];
	for (const b of boxes) {
		for (const line of b.lines) lines.push(align === "c" ? center(line, width) : padRight(line, width));
	}
	return { lines, baseline: (lines.length - 1) >> 1, width };
}

/** Stack `num` over `den`, separated by a bar; the bar becomes the baseline. */
function fracBox(num: Box, den: Box): Box {
	const width = Math.max(num.width, den.width) + 2;
	const lines = [
		...num.lines.map(line => center(line, width)),
		BAR.repeat(width),
		...den.lines.map(line => center(line, width)),
	];
	return { lines, baseline: num.lines.length, width };
}

/**
 * One vertical delimiter column of `height` rows for piece-table key `key`
 * (`"("`, `"{"`, …); null when `key` is empty (`\left.`). Unknown keys render a
 * single glyph at the baseline row.
 */
function delimColumn(key: string, height: number, baseline: number): Box | null {
	if (!key) return null;
	const pieces = DELIM_PIECES.get(key);
	if (height <= 1) {
		const only = pieces?.only ?? key;
		return only ? { lines: [only], baseline: 0, width: visibleWidth(only) } : null;
	}
	const width = visibleWidth(pieces?.only ?? key);
	if (pieces) return { lines: stretchedDelim(pieces, height, baseline), baseline, width };
	const blank = spaces(width);
	const lines: string[] = [];
	for (let y = 0; y < height; y++) lines.push(y === baseline ? key : blank);
	return { lines, baseline, width };
}

/**
 * `height` (at least 2) rows of `pieces`: the top piece, the middle fill with the
 * axis piece on the baseline row (kept off the two end rows), the bottom piece.
 */
function stretchedDelim(pieces: DelimPieces, height: number, baseline: number): string[] {
	const axisRow = clamp(baseline, 1, height - 2);
	const lines = [pieces.top];
	for (let y = 1; y < height - 1; y++) lines.push(y === axisRow && pieces.axis ? pieces.axis : pieces.mid);
	lines.push(pieces.bot);
	return lines;
}

/** Wrap `inner` in (possibly stretched) delimiters, padding tall content. */
function delimBox(inner: Box, left: string, right: string): Box {
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

/** `\binom{n}{k}`: `n` over `k` (no bar) inside stretched parentheses. */
function binomBox(top: Box, bottom: Box): Box {
	const width = Math.max(top.width, bottom.width);
	const lines = [
		...top.lines.map(line => center(line, width)),
		spaces(width),
		...bottom.lines.map(line => center(line, width)),
	];
	return delimBox({ lines, baseline: top.lines.length, width }, "(", ")");
}

/**
 * A drawn radical for a multi-line radicand: overline row on top, bar column
 * on the left, hook at the bottom. Single-line radicands stay flat (`√x̄`).
 */
function radicalBox(inner: Box, degree: string | null): Box {
	const lines: string[] = [` ┌${BAR.repeat(inner.width + 1)}`];
	for (let y = 0; y < inner.lines.length; y++) {
		lines.push((y === inner.lines.length - 1 ? "╲│ " : " │ ") + inner.lines[y]);
	}
	const box: Box = { lines, baseline: inner.baseline + 1, width: inner.width + 3 };
	if (!degree) return box;
	const deg = latexToUnicode(`^{${degree}}`);
	// Degree sits one row above the baseline, at the radical's upper left.
	return hconcat([{ lines: [deg, spaces(visibleWidth(deg))], baseline: 1, width: visibleWidth(deg) }, box]);
}

/** Big operator with limits: `sup` centered above `glyph`, `sub` below. */
function limitsBox(glyph: Box, sub: Box | null, sup: Box | null): Box {
	const width = Math.max(glyph.width, sub?.width ?? 0, sup?.width ?? 0);
	const lines: string[] = [];
	if (sup) for (const line of sup.lines) lines.push(center(line, width));
	const baseline = lines.length + glyph.baseline;
	for (const line of glyph.lines) lines.push(center(line, width));
	if (sub) for (const line of sub.lines) lines.push(center(line, width));
	return { lines, baseline, width };
}

/**
 * Attach block scripts to `base` as one shared right-hand column: the
 * superscript ends level with the base's top row (raised one row above a
 * single-line base), the subscript starts level with its bottom row (lowered
 * one row below a single-line base).
 */
function attachScripts(base: Box, sub: Box | null, sup: Box | null): Box {
	if (sub === null && sup === null) return base;
	const width = Math.max(sub?.width ?? 0, sup?.width ?? 0);
	const blank = spaces(width);
	const lines: string[] = [];
	let baseline = 0;
	if (sup) {
		pushPadded(lines, sup, width);
		pushBlank(lines, base.lines.length === 1 ? 1 : base.baseline, blank);
		baseline = lines.length - 1;
	}
	if (sub) {
		const drop = subscriptDrop(base, sub);
		// Rows between the baseline row and the subscript's top row.
		pushBlank(lines, lines.length === 0 ? drop : drop - 1, blank);
		pushPadded(lines, sub, width);
	}
	return hconcat([base, { lines, baseline, width }]);
}

/**
 * Rows from the base's baseline row down to the subscript's top row: level with
 * the base's bottom row, and at least one row below a single-line base. Under a
 * superscript, which ends on the baseline row, a drop of 0 places the subscript
 * on the next row as a drop of 1 does, since `pushBlank` adds no row for a
 * count below one.
 */
function subscriptDrop(base: Box, sub: Box): number {
	const below = base.lines.length - 1 - base.baseline - (sub.lines.length - 1);
	return Math.max(below, base.lines.length === 1 ? 1 : 0);
}

/** Append every line of `box` padded on the right to `width` visible columns. */
function pushPadded(lines: string[], box: Box, width: number): void {
	for (const line of box.lines) lines.push(padRight(line, width));
}

/** Append `count` copies of `blank`. */
function pushBlank(lines: string[], count: number, blank: string): void {
	for (let k = 0; k < count; k++) lines.push(blank);
}

/**
 * Lay out parsed cells as a grid: per-column width/alignment, per-gap width.
 * With `rowGap > 0` (matrix-family environments), blank rows separate the grid
 * rows and the total height is forced odd, so the baseline sits at the true
 * vertical center — `A = [matrix]` centers on the brackets, and stretched
 * braces get a real middle piece even for two content rows.
 */
function gridBox(rows: Box[][], align: (col: number) => CellAlign, gap: (col: number) => number, rowGap = 0): Box {
	const widths = columnWidths(rows);
	if (widths.length === 0) return textBox("");
	const rowBoxes: Box[] = [];
	for (const row of rows) {
		if (rowGap > 0 && rowBoxes.length > 0) {
			for (let g = 0; g < rowGap; g++) rowBoxes.push({ lines: [""], baseline: 0, width: 0 });
		}
		rowBoxes.push(gridRow(row, widths, align, gap));
	}
	const grid = vconcat(rowBoxes);
	if (rowGap > 0 && rows.length > 1 && grid.lines.length % 2 === 0) {
		return { lines: grid.lines.concat([spaces(grid.width)]), baseline: grid.lines.length >> 1, width: grid.width };
	}
	return grid;
}

/** The widest cell of each column; as many columns as the longest row has cells. */
function columnWidths(rows: Box[][]): number[] {
	const widths: number[] = [];
	for (const row of rows) {
		for (let j = 0; j < row.length; j++) widths[j] = Math.max(widths[j] ?? 0, row[j].width);
	}
	return widths;
}

/** One grid row: each cell padded to its column's width and alignment, `gap(col)` columns before each later cell. */
function gridRow(row: Box[], widths: number[], align: (col: number) => CellAlign, gap: (col: number) => number): Box {
	const parts: Box[] = [];
	for (let j = 0; j < widths.length; j++) {
		const g = j > 0 ? gap(j) : 0;
		if (g > 0) parts.push({ lines: [spaces(g)], baseline: 0, width: g });
		parts.push(padBox(row[j] ?? { lines: [""], baseline: 0, width: 0 }, widths[j], align(j)));
	}
	return hconcat(parts);
}

interface Span {
	text: string;
	end: number;
}

const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;

/**
 * Read a balanced `{…}` beginning at `i` (which must point at `{`): the text
 * between the outer braces, escapes and inner groups verbatim. An unbalanced
 * group runs to the end of `src`.
 */
function readBraceGroup(src: string, i: number): Span {
	let depth = 0;
	let j = i;
	for (; j < src.length; j++) {
		const c = src.charCodeAt(j);
		if (c === BACKSLASH) j++;
		else if (c === OPEN_BRACE) depth++;
		else if (c === CLOSE_BRACE && --depth === 0) return { text: src.slice(i + 1, j), end: j + 1 };
	}
	return { text: src.slice(i + 1), end: j };
}

/** The index after the run of ASCII letters starting at `j`. */
function letterRunEnd(src: string, j: number): number {
	while (isAsciiLetter(src.charCodeAt(j))) j++;
	return j;
}

/**
 * Read one command argument: a `{…}` group, a single char, or a `\command`
 * together with its attached `[…]`/`{…}` arguments (or whole `\begin…\end`
 * block), so e.g. `\frac\sqrt{a}{b}` reads `\sqrt{a}` as the numerator.
 */
function readArg(src: string, i: number): Span {
	while (src[i] === " ") i++;
	if (i >= src.length) return { text: "", end: i };
	if (src[i] === "{") return readBraceGroup(src, i);
	if (src[i] !== "\\") return { text: src[i], end: i + 1 };
	const j = letterRunEnd(src, i + 1);
	if (j === i + 1) return { text: src.slice(i, i + 2), end: i + 2 }; // non-letter command (\,, \{, …)
	if (j === i + 6 && src.startsWith("begin", i + 1)) {
		const env = consumeEnvironment(src, i);
		if (env) return env;
	}
	const end = skipAttachedArgs(src, j);
	return { text: src.slice(i, end), end };
}

/** The index after the `[…]`/`{…}` arguments attached at `j`; an unclosed `[` runs to the end of `src`. */
function skipAttachedArgs(src: string, j: number): number {
	while (src[j] === "[" || src[j] === "{") {
		if (src[j] === "{") {
			j = readBraceGroup(src, j).end;
		} else {
			const close = src.indexOf("]", j);
			j = close === -1 ? src.length : close + 1;
		}
	}
	return j;
}

/** Read a `\left`/`\right`/`\middle` delimiter token (char or `\command`). */
function readDelimToken(src: string, i: number): Span | null {
	while (src[i] === " ") i++;
	if (i >= src.length) return null;
	if (src[i] !== "\\") return { text: src[i], end: i + 1 };
	const j = letterRunEnd(src, i + 1);
	const end = j === i + 1 ? j + 1 : j;
	return { text: src.slice(i, end), end };
}

/** Piece-table key for a delimiter token; unknown commands resolve via Unicode. */
function delimKey(token: string): string {
	const mapped = DELIM_KEYS.get(token);
	if (mapped !== undefined) return mapped;
	return token.startsWith("\\") ? latexToUnicode(token).trim() : token;
}

interface LeftRightParts {
	left: string;
	/** Inner source split at top-level `\middle` delimiters. */
	segments: string[];
	middles: string[];
	right: string;
	end: number;
}

/** Parse `\left⟨tok⟩ … \right⟨tok⟩` starting at the backslash of `\left`. */
function readLeftRight(src: string, start: number): LeftRightParts | null {
	const left = readDelimToken(src, start + 5);
	if (!left) return null;
	const segments: string[] = [];
	const middles: string[] = [];
	let depth = 1;
	let k = left.end;
	let segStart = k;
	for (let cmd = nextDelimCommand(src, k); cmd !== null; cmd = nextDelimCommand(src, k)) {
		if (cmd.name === "middle" && depth !== 1) {
			k = cmd.at + 2; // a nested pair's `\middle`: only its head is skipped
		} else if (cmd.name === "left") {
			depth++;
			k = delimTokenAfter(src, cmd).end;
		} else if (cmd.name === "middle") {
			segments.push(src.slice(segStart, cmd.at));
			const tok = delimTokenAfter(src, cmd);
			middles.push(tok.text);
			k = segStart = tok.end;
		} else {
			const tok = delimTokenAfter(src, cmd);
			if (--depth === 0) {
				segments.push(src.slice(segStart, cmd.at));
				return { left: left.text, segments, middles, right: tok.text, end: tok.end };
			}
			k = tok.end;
		}
	}
	return null; // unbalanced
}

const DELIM_COMMANDS = ["left", "right", "middle"] as const;

interface DelimCommand {
	name: (typeof DELIM_COMMANDS)[number];
	/** Index of the command's backslash. */
	at: number;
}

/**
 * The next `\left`, `\right` or `\middle` at or after `k` (not `\leftarrow`);
 * any other backslash skips the character after it, so an escaped `\\left`
 * never reads as a command.
 */
function nextDelimCommand(src: string, k: number): DelimCommand | null {
	for (let at = src.indexOf("\\", k); at !== -1; at = src.indexOf("\\", at + 2)) {
		for (const name of DELIM_COMMANDS) {
			if (src.startsWith(name, at + 1) && !isAsciiLetter(src.charCodeAt(at + 1 + name.length))) return { name, at };
		}
	}
	return null;
}

/**
 * The delimiter token after `cmd`, or the null delimiter `.` ending right after the
 * command when the source ends there. Only a `\right` can end the source and still
 * close the pair, and `.` draws nothing in its place.
 */
function delimTokenAfter(src: string, cmd: DelimCommand): Span {
	const start = cmd.at + 1 + cmd.name.length;
	return readDelimToken(src, start) ?? { text: ".", end: start };
}

/**
 * Index of the `close` matching the `open` at `i`, skipping escapes and brace
 * groups; −1 when unbalanced (e.g. interval notation `[0, 1)`).
 */
function matchDelim(src: string, i: number, open: string, close: string): number {
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

interface EnvParts {
	env: string;
	bodyStart: number;
	bodyEnd: number;
	end: number;
}

/** Locate a `\begin{env}…\end{env}` block (balanced) starting at the backslash. */
function readEnvironment(src: string, start: number): EnvParts | null {
	let i = start + 6; // past "\begin"
	while (src[i] === " ") i++;
	if (src[i] !== "{") return null;
	const nameGroup = readBraceGroup(src, i);
	return closeEnvironment(src, nameGroup.text.trim(), nameGroup.end);
}

/**
 * The parts of environment `env` whose body starts at `bodyStart`: the body ends
 * at the backslash of the balancing `\end`, the block after its `{…}` name. With
 * no balancing `\end`, both run to the end of `src`.
 */
function closeEnvironment(src: string, env: string, bodyStart: number): EnvParts {
	let depth = 1;
	let k = bodyStart;
	while (k < src.length) {
		if (src.startsWith("\\begin", k)) {
			depth++;
			k += 6;
		} else if (src.startsWith("\\end", k)) {
			const bodyEnd = k;
			k = skipEnvironmentName(src, k + 4);
			if (--depth === 0) return { env, bodyStart, bodyEnd, end: k };
		} else {
			const next = src.indexOf("\\", k + 1);
			k = next === -1 ? src.length : next;
		}
	}
	return { env, bodyStart, bodyEnd: src.length, end: k };
}

/** The index after the spaces and `{…}` name that follow `\end` at `k`. */
function skipEnvironmentName(src: string, k: number): number {
	while (src[k] === " ") k++;
	return src[k] === "{" ? readBraceGroup(src, k).end : k;
}

/** The full `\begin{env}…\end{env}` substring as an inline run. */
function consumeEnvironment(src: string, start: number): Span | null {
	const env = readEnvironment(src, start);
	return env ? { text: src.slice(start, env.end), end: env.end } : null;
}

/**
 * Brace and environment depth while scanning source left to right, so a
 * separator counts only at the top level.
 */
class NestingDepth {
	#braces = 0;
	#environments = 0;

	get topLevel(): boolean {
		return this.#braces === 0 && this.#environments === 0;
	}

	/**
	 * The index after the construct at `i`, counting `\begin`, `\end` and braces.
	 * Any other backslash spans two characters, so `\{` and `\\` never change the depth.
	 */
	advance(src: string, i: number): number {
		const c = src.charCodeAt(i);
		if (c === BACKSLASH) {
			if (src.startsWith("begin", i + 1)) {
				this.#environments++;
				return i + 6;
			}
			if (src.startsWith("end", i + 1)) {
				this.#environments--;
				return i + 4;
			}
			return i + 2;
		}
		if (c === OPEN_BRACE) this.#braces++;
		else if (c === CLOSE_BRACE) this.#braces--;
		return i + 1;
	}
}

/**
 * Split on top-level `\\` row breaks (depth-aware: never inside braces or a nested
 * environment). An environment body has no other row separator; display source
 * also breaks on a top-level `\n`, so `latexToBlock` passes `newlineBreaks`.
 */
function splitRowBreaks(src: string, newlineBreaks: boolean): string[] {
	const rows: string[] = [];
	const depth = new NestingDepth();
	let last = 0;
	let i = 0;
	while (i < src.length) {
		if (src.charCodeAt(i) === BACKSLASH && src.charCodeAt(i + 1) === BACKSLASH && depth.topLevel) {
			rows.push(src.slice(last, i));
			i = last = skipRowBreakSpacing(src, i + 2);
		} else if (newlineBreaks && src[i] === "\n" && depth.topLevel) {
			rows.push(src.slice(last, i));
			last = ++i;
		} else {
			i = depth.advance(src, i);
		}
	}
	rows.push(src.slice(last));
	return rows;
}

/** The index after the spaces and optional `[…]` spacing argument following a `\\` row break at `i`. */
function skipRowBreakSpacing(src: string, i: number): number {
	while (src[i] === " ") i++;
	if (src[i] !== "[") return i;
	const close = src.indexOf("]", i);
	return close === -1 ? src.length : close + 1;
}

/** Split a row on top-level `&` column separators (depth-aware), trimming cells. */
function splitCells(row: string): string[] {
	const cells: string[] = [];
	const depth = new NestingDepth();
	let last = 0;
	let i = 0;
	while (i < row.length) {
		if (row[i] === "&" && depth.topLevel) {
			cells.push(row.slice(last, i).trim());
			last = ++i;
		} else {
			i = depth.advance(row, i);
		}
	}
	cells.push(row.slice(last).trim());
	return cells;
}

/** Append a script (`^`/`_`) and its argument to the inline run verbatim. */
function readScript(src: string, i: number): Span {
	let out = src[i];
	i++;
	while (src[i] === " ") {
		out += src[i];
		i++;
	}
	if (src[i] === "{") {
		const group = readBraceGroup(src, i);
		return { text: `${out}{${group.text}}`, end: group.end };
	}
	if (src[i] === "\\") {
		let j = letterRunEnd(src, i + 1);
		if (j === i + 1) j++;
		return { text: out + src.slice(i, j), end: j };
	}
	if (i < src.length) return { text: out + src[i], end: i + 1 };
	return { text: out, end: i };
}

/** Bare argument of a script read by `readScript` (`^{ab}` → `ab`, `^a` → `a`). */
function scriptArgOf(text: string): string {
	let arg = text.slice(1).trimStart();
	if (arg.startsWith("{") && arg.endsWith("}")) arg = arg.slice(1, -1);
	return arg;
}

/** A `^`/`_` script and an immediately following opposite script (`M_i^j`), read as one pair. */
interface ScriptPair {
	sup: string | undefined;
	sub: string | undefined;
	end: number;
}

/**
 * Read the `c` script at `i` together with an immediately following opposite
 * script, so both land in one shared column instead of two successive ones.
 */
function readScriptPair(src: string, i: number, c: "^" | "_"): ScriptPair {
	const first = readScript(src, i);
	let n = first.end;
	while (src[n] === " ") n++;
	const second = src[n] === (c === "^" ? "_" : "^") ? readScript(src, n) : null;
	const end = second === null ? first.end : second.end;
	return c === "^" ? { sup: first.text, sub: second?.text, end } : { sup: second?.text, sub: first.text, end };
}

/**
 * Render a `\begin{env}…\end{env}` block. Grid environments (matrix family,
 * cases, array) become baseline-aligned 2-D grids in stretched delimiters;
 * wrapper environments (`align`, `gather`, …) parse each `\\` row, aligning `&`
 * columns; anything else (tabular, …) renders flat via `latexToUnicode`.
 */
function parseEnvironment(src: string, start: number, ctx: Ctx): { box: Box; end: number } | null {
	const env = readEnvironment(src, start);
	if (env === null) return null;
	const starred = env.env.endsWith("*");
	const base = starred ? env.env.slice(0, -1) : env.env;
	const gridDelims = GRID_ENVIRONMENTS.get(base);
	let box: Box;
	if (gridDelims) box = gridEnvironmentBox(src, env, base, starred, gridDelims, ctx);
	else if (DISPLAY_ROW_ENVIRONMENTS.has(base)) box = rowEnvironmentBox(src, env, base, ctx);
	else box = textBox(latexToUnicode(ctx.wrap(src.slice(start, env.end))));
	return { box, end: env.end };
}

const CASES_ENVIRONMENTS: ReadonlySet<string> = new Set(["cases", "dcases", "rcases", "drcases"]);

/** A matrix-family, cases or array body as a grid of parsed cells inside its stretched delimiters. */
function gridEnvironmentBox(
	src: string,
	env: EnvParts,
	base: string,
	starred: boolean,
	delims: readonly [string, string],
	ctx: Ctx,
): Box {
	let p = skipLayoutSpace(src, env.bodyStart);
	if (starred && src[p] === "[") {
		// Starred matrix variants take an optional alignment argument.
		const close = src.indexOf("]", p);
		if (close !== -1 && close < env.bodyEnd) p = skipLayoutSpace(src, close + 1);
	}
	let colSpec: CellAlign[] | null = null;
	if (base === "array" && src[p] === "{") {
		const spec = readBraceGroup(src, p);
		colSpec = [...spec.text].filter((ch): ch is CellAlign => ch === "l" || ch === "c" || ch === "r");
		p = spec.end;
	}
	const cells = splitRowBreaks(src.slice(p, env.bodyEnd), false)
		.map(row => row.trim())
		.filter(row => row !== "")
		.map(row => splitCells(row).map(cell => parseExpr(cell, ctx)));
	const align: (col: number) => CellAlign = colSpec
		? col => colSpec[col] ?? "c"
		: CASES_ENVIRONMENTS.has(base)
			? () => "l"
			: () => "c";
	return delimBox(
		gridBox(cells, align, () => 2, 1),
		delims[0],
		delims[1],
	);
}

/** The index after the spaces, newlines and tabs at `p`. */
function skipLayoutSpace(src: string, p: number): number {
	while (src[p] === " " || src[p] === "\n" || src[p] === "\t") p++;
	return p;
}

// Row environments that take a required column-count argument `{n}` before the body.
const COLUMN_COUNT_ENVIRONMENTS: ReadonlySet<string> = new Set(["alignat", "alignedat", "gatheredat"]);
// Row environments whose single-column rows are centered rather than left-aligned.
const CENTERED_ROW_ENVIRONMENTS: ReadonlySet<string> = new Set(["gather", "gathered", "multline"]);

/** An `align`/`gather`-family body: each `\\` row parsed, with `&` columns aligned. */
function rowEnvironmentBox(src: string, env: EnvParts, base: string, ctx: Ctx): Box {
	let bodyStart = env.bodyStart;
	if (COLUMN_COUNT_ENVIRONMENTS.has(base)) {
		let p = bodyStart;
		while (src[p] === " " || src[p] === "\n") p++;
		if (src[p] === "{") bodyStart = readBraceGroup(src, p).end;
	}
	const rows = splitRowBreaks(src.slice(bodyStart, env.bodyEnd), false)
		.map(row => row.trim())
		.filter(row => row !== "");
	if (rows.length === 0) return textBox("");
	const cellRows = rows.map(splitCells);
	let ncols = 0;
	for (const row of cellRows) ncols = Math.max(ncols, row.length);
	if (ncols <= 1) {
		return vconcat(
			rows.map(row => parseExpr(row, ctx)),
			CENTERED_ROW_ENVIRONMENTS.has(base) ? "c" : "l",
		);
	}
	// `align`-family semantics: columns alternate right/left in `rl` pairs, a
	// thin gap inside each pair and a wide gap between pairs.
	return gridBox(
		cellRows.map(row => row.map(cell => parseExpr(cell, ctx))),
		col => (col % 2 === 0 ? "r" : "l"),
		col => (col % 2 === 1 ? 1 : 3),
	);
}

/**
 * Paint every line of `box` through a `latexColorScope` painter so structural
 * glyphs (fraction bars, stretched delimiters, matrix brackets) inherit the
 * enclosing color scope while nested color runs still restore to it.
 */
function colorizeBox(box: Box, scope: (text: string) => string): Box {
	return { lines: box.lines.map(scope), baseline: box.baseline, width: box.width };
}

/**
 * Parse a math fragment into a layout box. 2-D constructs — fractions, binomials,
 * radicals over tall content, `\left…\right` and tall bare parens, environments,
 * big-operator limits, block scripts — become stacked boxes; everything between
 * them is gathered into inline runs rendered through `latexToUnicode` under the
 * active scope wrapper (`ctx`), with `\color` state re-applied per run.
 */
/**
 * Recursion guard for the 2-D block layout. `parseExpr` recurses through
 * fractions/binoms/radicals/scripts/groups/environment cells, and the box layout
 * cost is super-linear in nesting depth — a depth-1000 `\frac` chain took ~6.6s
 * and deeper hangs for minutes, so model-authored display math is a trivial DoS.
 * Past this depth, degrade the remaining source to a single flat inline box via
 * the (linear, depth-guarded) `latexToUnicode` instead of recursing further. Real
 * display math nests only a handful deep; continued fractions rarely past ~10.
 * `parseExpr` is fully synchronous, so a module-level counter unwinds correctly.
 */
const MAX_BLOCK_DEPTH = 64;
// Longest tail flattened inline at the depth cap. Past MAX_BLOCK_DEPTH the source
// is unreadable as 2-D layout; a giant tail (a 50k-deep `\frac` chain is ~300KB)
// would make even the linear `latexToUnicode` degrade costly via bubbling string
// concatenation, so flatten only a bounded prefix. Real math never reaches here.
const MAX_BLOCK_DEGRADE_TAIL = 2048;
let blockDepth = 0;

function parseExpr(src: string, ctx: Ctx = ROOT_CTX): Box {
	if (blockDepth >= MAX_BLOCK_DEPTH) {
		return textBox(
			latexToUnicode(src.length > MAX_BLOCK_DEGRADE_TAIL ? `${src.slice(0, MAX_BLOCK_DEGRADE_TAIL)}…` : src),
		);
	}
	blockDepth++;
	try {
		return new ExprParser(src, ctx).parse();
	} finally {
		blockDepth--;
	}
}

/**
 * The converter falls back to `^(…)`/`_(…)` when any character of a script
 * lacks a Unicode script form; those scripts get real raised/lowered boxes.
 */
function isUnconvertibleScript(raw: string | undefined): boolean {
	if (raw === undefined) return false;
	const flat = latexToUnicode(raw);
	return flat.startsWith("^") || flat.startsWith("_");
}

/** `\left … \middle … \right` as stretched delimiter columns around the parsed segments. */
function leftRightBox(lr: LeftRightParts, segments: Box[], height: number, above: number): Box {
	const parts: Box[] = [];
	const left = delimColumn(delimKey(lr.left), height, above);
	if (left) parts.push(left);
	for (let s = 0; s < segments.length; s++) {
		parts.push(segments[s]);
		if (s < lr.middles.length) {
			const middle = delimColumn(delimKey(lr.middles[s]), height, above);
			if (middle) parts.push(middle);
		}
	}
	const right = delimColumn(delimKey(lr.right), height, above);
	if (right) parts.push(right);
	return hconcat(parts);
}

/** The `[model]{color}` arguments of `\textcolor`, re-emitted as `prefix`, and the scope they select. */
interface TextColorSpec {
	prefix: string;
	scope: ((text: string) => string) | null;
	/** Index after the color argument and the spaces following it. */
	end: number;
}

/** The `\textcolor` color arguments at `k`; null when no `{color}` argument follows. */
function readTextColorSpec(src: string, k: number): TextColorSpec | null {
	let model: string | null = null;
	let prefix = "";
	if (src[k] === "[") {
		const close = src.indexOf("]", k);
		if (close !== -1) {
			model = src.slice(k + 1, close).trim();
			prefix = src.slice(k, close + 1);
			k = close + 1;
			while (src[k] === " ") k++;
		}
	}
	if (src[k] !== "{") return null;
	const spec = readBraceGroup(src, k);
	let end = spec.end;
	while (src[end] === " ") end++;
	return { prefix: `${prefix}{${spec.text}}`, scope: latexColorScope(model, spec.text), end };
}

/**
 * One left-to-right pass over a math fragment. Finished 2-D constructs collect
 * in `#boxes`; flat text accumulates in `#inline` and becomes one
 * `latexToUnicode` box on the next `#flush`. `#color`/`#colorScope` track the
 * active `\color` switch, which applies to every later run and box in this
 * fragment. Each `#…` handler consumes one construct at `#i` and advances it.
 */
class ExprParser {
	readonly #src: string;
	readonly #ctx: Ctx;
	readonly #boxes: Box[] = [];
	#inline = "";
	#color = "";
	#colorScope: ((text: string) => string) | null = null;
	#i = 0;

	constructor(src: string, ctx: Ctx) {
		this.#src = src;
		this.#ctx = ctx;
	}

	parse(): Box {
		const src = this.#src;
		while (this.#i < src.length) {
			const c = src[this.#i];
			if (c === "\\") {
				this.#command();
			} else if (c === "^" || c === "_") {
				this.#scripts(c);
			} else if (c === "{") {
				this.#braceGroup();
			} else if (!((c === "(" || c === "[") && this.#bareDelimiter(c))) {
				this.#inline += c;
				this.#i++;
			}
		}
		this.#flush();
		if (this.#boxes.length === 0) return textBox("");
		return hconcat(this.#boxes);
	}

	#flush(): void {
		if (!this.#inline) return;
		this.#boxes.push(textBox(latexToUnicode(this.#ctx.wrap(this.#color + this.#inline))));
		this.#inline = "";
	}

	/** Child context carrying the enclosing wrapper plus current color state. */
	#inner(): Ctx {
		if (!this.#color) return this.#ctx;
		const pre = this.#color;
		const ctx = this.#ctx;
		return { wrap: run => ctx.wrap(pre + run) };
	}

	/** Apply the active `\color` scope to a structural box's glyphs. */
	#paint(box: Box): Box {
		return this.#colorScope === null ? box : colorizeBox(box, this.#colorScope);
	}

	/** Flush the pending run, then append a finished structural box. */
	#emit(box: Box): void {
		this.#flush();
		this.#boxes.push(this.#paint(box));
	}

	#command(): void {
		const src = this.#src;
		const j = letterRunEnd(src, this.#i + 1);
		const name = src.slice(this.#i + 1, j);
		if (!name) {
			// Non-letter command (`\\`, `\,`, `\{`, …): keep the 2-char token inline.
			this.#inline += `\\${src[j] ?? ""}`;
			this.#i = j + 1;
		} else if (!this.#layoutCommand(name, j)) {
			this.#otherCommand(name, j);
		}
	}

	/** Lay out a command with a 2-D form; false when `name` stays an ordinary inline command. */
	#layoutCommand(name: string, j: number): boolean {
		if (FRAC_COMMANDS.has(name)) this.#twoArgs(j, fracBox);
		else if (BINOM_COMMANDS.has(name)) this.#twoArgs(j, binomBox);
		else if (name === "sqrt") this.#sqrt(j);
		else if (name === "left") return this.#leftRight();
		else if (LIMIT_OPERATORS.has(name) || INTEGRAL_OPERATORS.has(name)) this.#bigOperator(name, j);
		else if (name === "color" || name === "normalcolor") this.#setColor(name, j);
		else if (name === "begin") return this.#environment();
		else if (MATH_FONT_COMMANDS.has(name) || name === "textcolor") return this.#scopedWrapper(name, j);
		else return false;
		return true;
	}

	/** `\frac{a}{b}` / `\binom{n}{k}`: two arguments laid out by `layout`. */
	#twoArgs(j: number, layout: (first: Box, second: Box) => Box): void {
		const first = readArg(this.#src, j);
		const second = readArg(this.#src, first.end);
		this.#flush();
		this.#boxes.push(
			this.#paint(layout(parseExpr(first.text, this.#inner()), parseExpr(second.text, this.#inner()))),
		);
		this.#i = second.end;
	}

	#sqrt(j: number): void {
		const src = this.#src;
		let k = j;
		while (src[k] === " ") k++;
		let degree: string | null = null;
		if (src[k] === "[") {
			const close = src.indexOf("]", k);
			degree = src.slice(k + 1, close === -1 ? src.length : close);
			k = close === -1 ? src.length : close + 1;
		}
		const arg = readArg(src, k);
		// Display style always draws the roof (like LaTeX); inline math
		// keeps the flat `√(…)` form via latexToUnicode.
		this.#flush();
		this.#boxes.push(this.#paint(radicalBox(parseExpr(arg.text, this.#inner()), degree)));
		this.#i = arg.end;
	}

	/** `\left … \right`; false when the pair is unbalanced and `\left` stays an ordinary command. */
	#leftRight(): boolean {
		const lr = readLeftRight(this.#src, this.#i);
		if (!lr) return false;
		const segBoxes = lr.segments.map(segment => parseExpr(segment, this.#inner()));
		let above = 0;
		let below = 0;
		for (const b of segBoxes) {
			above = Math.max(above, b.baseline);
			below = Math.max(below, b.lines.length - 1 - b.baseline);
		}
		const height = above + below + 1;
		if (height === 1) {
			// Single-line: keep the whole span inline so converter
			// state (fonts, colors, spacing) is preserved.
			this.#inline += this.#src.slice(this.#i, lr.end);
		} else {
			this.#emit(leftRightBox(lr, segBoxes, height, above));
		}
		this.#i = lr.end;
		return true;
	}

	/** `\sum`, `\lim`, `\int`, …, honoring a trailing `\limits` / `\nolimits`. */
	#bigOperator(name: string, j: number): void {
		const src = this.#src;
		let k = j;
		while (src[k] === " ") k++;
		let stack = LIMIT_OPERATORS.has(name);
		let resume = j; // resume point when the operator stays inline
		if (src.startsWith("\\limits", k) && !isAsciiLetter(src.charCodeAt(k + 7))) {
			stack = true;
			resume = k = k + 7;
		} else if (src.startsWith("\\nolimits", k) && !isAsciiLetter(src.charCodeAt(k + 9))) {
			stack = false;
			resume = k + 9;
		}
		if (stack && this.#stackedLimits(name, k)) return;
		this.#inline += `\\${name}`;
		this.#i = resume;
	}

	/** Stack the operator's `_`/`^` scripts starting at `k` above and below it; false when it has none. */
	#stackedLimits(name: string, k: number): boolean {
		const src = this.#src;
		let subText: string | null = null;
		let supText: string | null = null;
		let m = k;
		for (;;) {
			// Peek past spaces without consuming them, so a run
			// following the operator keeps its leading space.
			let n = m;
			while (src[n] === " ") n++;
			if (src[n] === "_" && subText === null) {
				const arg = readArg(src, n + 1);
				subText = arg.text;
				m = arg.end;
				continue;
			}
			if (src[n] === "^" && supText === null) {
				const arg = readArg(src, n + 1);
				supText = arg.text;
				m = arg.end;
				continue;
			}
			break;
		}
		if (subText === null && supText === null) return false;
		this.#flush();
		const glyph = textBox(latexToUnicode(this.#ctx.wrap(`${this.#color}\\${name}`)));
		const sub = subText === null ? null : parseExpr(subText, this.#inner());
		const sup = supText === null ? null : parseExpr(supText, this.#inner());
		this.#boxes.push(this.#paint(limitsBox(glyph, sub, sup)));
		this.#i = m;
		return true;
	}

	/** `\color{…}` / `\color[model]{…}` / `\normalcolor`: switch the color for the rest of the fragment. */
	#setColor(name: string, j: number): void {
		this.#flush(); // preceding run keeps the previous color
		if (name === "normalcolor") {
			this.#color = "";
			this.#colorScope = null;
			this.#i = j;
			return;
		}
		const src = this.#src;
		let k = j;
		while (src[k] === " ") k++;
		let opt = "";
		if (src[k] === "[") {
			const close = src.indexOf("]", k);
			if (close !== -1) {
				opt = src.slice(k, close + 1);
				k = close + 1;
				while (src[k] === " ") k++;
			}
		}
		if (src[k] === "{") {
			const spec = readBraceGroup(src, k);
			this.#color = `\\color${opt}{${spec.text}}`;
			this.#colorScope = latexColorScope(opt ? opt.slice(1, -1).trim() : null, spec.text);
			this.#i = spec.end;
		} else {
			this.#color = "";
			this.#colorScope = null;
			this.#i = k;
		}
	}

	/** `\begin{env}…\end{env}`; false when unbalanced and `\begin` stays an ordinary command. */
	#environment(): boolean {
		const env = parseEnvironment(this.#src, this.#i, this.#inner());
		if (!env) return false;
		this.#emit(env.box);
		this.#i = env.end;
		return true;
	}

	/**
	 * Scoped wrapper around 2-D content (`\mathbf{…}`, `\textcolor{c}{…}`):
	 * recurse with the wrapper re-applied to every inline run, so styling
	 * crosses boxes. False when no `{…}` body follows a font command, which
	 * then stays an ordinary command.
	 */
	#scopedWrapper(name: string, j: number): boolean {
		const src = this.#src;
		let k = j;
		while (src[k] === " ") k++;
		let prefix = `\\${name}`;
		let scope: ((text: string) => string) | null = null;
		if (name === "textcolor") {
			const color = readTextColorSpec(src, k);
			if (color === null) {
				this.#inline += prefix;
				this.#i = j;
				return true;
			}
			prefix += color.prefix;
			scope = color.scope;
			k = color.end;
		}
		if (src[k] !== "{") return false;
		const content = readBraceGroup(src, k);
		this.#flush();
		const pre = this.#color;
		const ctx = this.#ctx;
		let box = parseExpr(content.text, { wrap: run => ctx.wrap(`${pre}${prefix}{${run}}`) });
		if (scope !== null) box = colorizeBox(box, scope);
		this.#boxes.push(this.#paint(box));
		this.#i = content.end;
		return true;
	}

	/**
	 * Any other command: keep it and its bracket/brace arguments inline so a
	 * `{…}` argument is never mistaken for a top-level stacking group.
	 */
	#otherCommand(name: string, j: number): void {
		const src = this.#src;
		this.#inline += `\\${name}`;
		let i = j;
		while (src[i] === "[" || src[i] === "{") {
			if (src[i] === "{") {
				const group = readBraceGroup(src, i);
				this.#inline += `{${group.text}}`;
				i = group.end;
			} else {
				const close = src.indexOf("]", i);
				const end = close === -1 ? src.length : close + 1;
				this.#inline += src.slice(i, end);
				i = end;
			}
		}
		this.#i = i;
	}

	/** `^`/`_` scripts, consuming an immediately following opposite script. */
	#scripts(c: "^" | "_"): void {
		const start = this.#i;
		const { sup, sub, end } = readScriptPair(this.#src, start, c);
		const supBox = sup === undefined ? null : parseExpr(scriptArgOf(sup), this.#inner());
		const subBox = sub === undefined ? null : parseExpr(scriptArgOf(sub), this.#inner());
		this.#i = end;
		const tall = (supBox !== null && supBox.lines.length > 1) || (subBox !== null && subBox.lines.length > 1);
		if (tall || isUnconvertibleScript(sup) || isUnconvertibleScript(sub)) {
			// Block script (`x^{\frac{1}{2}}`, `x^q`): raise/lower the boxes
			// against the run or box they follow.
			this.#flush();
			const base = this.#boxes.pop() ?? textBox("");
			this.#boxes.push(this.#paint(attachScripts(base, subBox, supBox)));
			return;
		}
		const boxes = this.#boxes;
		const last = boxes[boxes.length - 1];
		if (this.#inline === "" && last !== undefined && last.lines.length > 1) {
			// Scripts directly on a tall box (`M^T`, `\right|_{x=a}`): pin
			// the Unicode script glyphs (guaranteed convertible here after
			// the gate above) to its corners.
			boxes[boxes.length - 1] = this.#paint(attachScripts(last, this.#corner(sub), this.#corner(sup)));
			return;
		}
		this.#inline += this.#src.slice(start, end);
	}

	/** A convertible script as a flat corner glyph in the active color. */
	#corner(raw: string | undefined): Box | null {
		return raw === undefined ? null : textBox(latexToUnicode(this.#ctx.wrap(this.#color + raw)));
	}

	#braceGroup(): void {
		const group = readBraceGroup(this.#src, this.#i);
		this.#emit(parseExpr(group.text, this.#inner()));
		this.#i = group.end;
	}

	/**
	 * Bare delimiters stretch when their content is tall (common in model
	 * output that omits `\left`/`\right`). False when unbalanced or flat, and
	 * the opening character stays in the inline run.
	 */
	#bareDelimiter(c: "(" | "["): boolean {
		const closeCh = c === "(" ? ")" : "]";
		const close = matchDelim(this.#src, this.#i, c, closeCh);
		if (close === -1) return false;
		const innerBox = parseExpr(this.#src.slice(this.#i + 1, close), this.#inner());
		if (innerBox.lines.length <= 1) return false;
		this.#emit(delimBox(innerBox, c, closeCh));
		this.#i = close + 1;
		return true;
	}
}

/**
 * Render a display LaTeX math fragment to lines with full 2-D layout: stacked
 * fractions, stretchy delimiters, matrix grids, operator limits, drawn
 * radicals. Top-level source newlines and `\\` become vertical rows (so a
 * `lhs =` line stays above its block). Inline math should use `latexToUnicode`
 * instead — fractions there stay single-line.
 */
export function latexToBlock(src: string): string[] {
	if (typeof src !== "string" || src.trim() === "") return [];
	const rows = splitRowBreaks(src.trim(), true)
		.map(line => line.trim())
		.filter(line => line !== "")
		.map(line => parseExpr(line));
	if (rows.length === 0) return [];
	let lines = vconcat(rows).lines;
	while (lines.length > 1 && lines[lines.length - 1].trim() === "") lines = lines.slice(0, -1);
	while (lines.length > 1 && lines[0].trim() === "") lines = lines.slice(1);
	return lines;
}
