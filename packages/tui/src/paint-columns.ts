// Repainting the background of a rendered line, column by column.
//
// `motion-paint.ts` can already fade a whole line toward a ground, which is
// enough for an animation that treats a row as one object. It is not enough for
// anything that moves ACROSS a row: a specular sweep, a band with a direction, a
// surface lit from one side. Those need to know which column they are on.
//
// The transform stays where motion-paint's does — over lines a component has
// already rendered — so a component never learns that a sweep is crossing it, and
// every frame is byte-assertable. What is added here is column tracking: the line
// is walked once, the background in effect is tracked as it goes, and a caller's
// function is asked, per column, what the background should be instead.
//
// A new SGR is written only where the answer CHANGES, so a caller that quantizes
// its gradient into ten steps pays for ten sequences and not for one per cell.
// That matters: these run on every frame of an animation over every row of a card,
// and a per-cell background is nineteen bytes a cell.
//
// Only truecolor backgrounds are read. An indexed background (`48;5;n`) is
// reported as `undefined` and left untouched, on the same reasoning motion-paint
// gives: resolving it means carrying a palette the terminal may not be using, and
// a wrong guess is a visible colour shift rather than a missing effect.

import { CSI, sgrSequence } from "./ansi";
import { toHexColor } from "./motion-paint";
import { parseHexColor } from "./paint-ground";
import { getSegmenter, visibleWidth } from "./utils";

/** What the caller is told about one column of the line. */
export interface ColumnPaint {
	/** Zero-based visible column. A double-width grapheme reports its first column only. */
	col: number;
	/**
	 * The background in effect, as `#rrggbb`, or undefined for the terminal's
	 * default ground and for any background this module will not guess at.
	 */
	background: string | undefined;
	/** True for a column past the end of the line's own content. */
	past: boolean;
}

/**
 * The background a column should paint, or undefined to leave the column exactly
 * as the component wrote it.
 */
export type ColumnPainter = (column: ColumnPaint) => string | undefined;

/**
 * The columns of a row a treatment owns.
 *
 * A card's rows are as wide as the screen: the leading padding that centres the
 * card and the trailing space beside it belong to the page, not to the card. A
 * treatment given no window paints all of them, which puts a card's own light out
 * on the page beside it.
 */
export interface ColumnWindow {
	/** First column the treatment may touch. */
	start: number;
	/** One past the last column the treatment may touch. */
	end: number;
}

const SGR = sgrSequence("g");

/** The truecolor background a run of SGR parameters leaves in effect. */
function trackBackground(current: string | undefined, params: string): string | undefined {
	// `\x1b[m` is `\x1b[0m`: an empty parameter list is a full reset.
	const codes = params === "" ? ["0"] : params.split(";");
	let background = current;
	for (let i = 0; i < codes.length; i++) {
		const code = codes[i];
		if (code === "0" || code === "") background = undefined;
		else if (code === "49") background = undefined;
		else if (code === "48") {
			// 48;2;r;g;b is truecolor and readable; 48;5;n is indexed and is not.
			if (codes[i + 1] === "2") {
				const r = Number(codes[i + 2]);
				const g = Number(codes[i + 3]);
				const b = Number(codes[i + 4]);
				background =
					Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) ? toHexColor(r, g, b) : undefined;
				i += 4;
			} else if (codes[i + 1] === "5") {
				background = undefined;
				i += 2;
			}
		} else if (code.startsWith("48:")) {
			// Colon form: `48:2::r:g:b` or `48:2:r:g:b`.
			const parts = code.split(":").filter(part => part !== "");
			if (parts[1] === "2" && parts.length >= 5) {
				const [r, g, b] = parts.slice(-3).map(Number);
				background =
					Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) ? toHexColor(r, g, b) : undefined;
			} else background = undefined;
		}
	}
	return background;
}

/**
 * Whether a run of SGR parameters says anything about the BACKGROUND.
 *
 * The distinction is what keeps a treatment inside its window. A component's own
 * `\x1b[39m` closes a foreground and leaves the background exactly as it was, so a
 * pass that treated every component sequence as "the background is whatever the
 * component had now" would believe its own paint had been closed and stop emitting
 * the `49m` that actually closes it. The paint then survived past the last column
 * it owned — visibly, as the card's surface running off its right edge and out
 * across the page.
 */
function touchesBackground(params: string): boolean {
	const codes = params === "" ? ["0"] : params.split(";");
	for (const code of codes) {
		if (code === "0" || code === "" || code === "49" || code === "48") return true;
		if (code.startsWith("48:")) return true;
		// The 8/16-colour background ranges. Not read as a colour (see the module
		// header) but they do change the background, so a paint over them is closed.
		const value = Number(code);
		if (Number.isInteger(value) && ((value >= 40 && value <= 47) || (value >= 100 && value <= 107))) return true;
	}
	return false;
}

function bgSequence(hex: string): string {
	const rgb = parseHexColor(hex);
	if (!rgb) return "";
	return `${CSI}48;2;${rgb.r};${rgb.g};${rgb.b}m`;
}

/**
 * Repaint one rendered line's background, asking `painter` what each column
 * should be.
 *
 * The line is extended to `width` columns with spaces, because a surface that
 * stops where its text stops is not a surface: the sweep, the gradient and the
 * fill all have to reach the edge of the card. Text, foreground colours and every
 * attribute the component wrote are preserved untouched; only backgrounds move.
 */
export function paintLineBackground(
	line: string,
	width: number,
	painter: ColumnPainter,
	window?: ColumnWindow,
): string {
	// A window bounds the padding as well as the painter. Padding a row out to the
	// full area so a treatment can reach a card's right edge is correct; doing it
	// when the treatment stops at that edge writes spaces across the page instead.
	const first = window === undefined ? 0 : Math.max(0, window.start);
	const last = window === undefined ? width : Math.min(width, window.end);
	const content = visibleWidth(line);
	const padded = content < last ? line + " ".repeat(last - content) : line;

	let out = "";
	let col = 0;
	// The background the component asked for, and the one currently emitted, so a
	// span that ends can restore what the component had rather than resetting.
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
		// The component's own sequence is written verbatim, so its foreground and
		// attributes survive. Whether it also cleared the background this pass had
		// open is the question `touchesBackground` answers: if it did, the terminal is
		// back on the component's own background and the next cell re-asserts whatever
		// it needs; if it did not — a bare `39m`, an attribute, a foreground colour —
		// this pass's paint is still in effect and must still be closed by this pass.
		out += match[0];
		if (touchesBackground(params)) paintedBg = componentBg;
		index = match.index + match[0].length;
	}
	emitText(padded.slice(index), emitCell);

	// Leave the line as the component left it: a background this pass opened must
	// not leak into whatever the host writes next.
	if (paintedBg !== undefined) out += `${CSI}49m`;
	return out;
}

/** Walk a run of plain text as graphemes, reporting each cell's width. */
function emitText(text: string, emitCell: (text: string, width: number) => void): void {
	if (text === "") return;
	// Graphemes, not code points: a combining mark or a ZWJ sequence is one cell,
	// and splitting it would paint half of it and measure the rest wrong.
	for (const { segment } of getSegmenter().segment(text)) {
		emitCell(segment, visibleWidth(segment));
	}
}

/** Every line of a block, repainted with the same painter. Rows are numbered from 0. */
export function paintBlockBackground(
	lines: readonly string[],
	width: number,
	painter: (row: number) => ColumnPainter | null,
	window?: ColumnWindow,
): string[] {
	return lines.map((line, row) => {
		const columnPainter = painter(row);
		return columnPainter === null ? line : paintLineBackground(line, width, columnPainter, window);
	});
}
