/**
 * The caret lands where the glyph widths put it.
 *
 * WHY THIS SUITE EXISTS:
 * Nothing in this package checked the caret column against the text in front of it. The composer
 * computes the caret's screen position from the display width of the editor text, and the engine
 * then places it (`altCaret` in tui.ts, computed while the window is assembled). Every existing
 * check runs on ASCII, where a character is a code point is a cell, so the three ways that
 * arithmetic can go wrong are all invisible: a wide glyph is two cells, a combining mark is zero,
 * and an astral pair is one glyph in two UTF-16 code units.
 *
 * WHY AN ADVANCE AND NOT A POSITION:
 * Asserting an absolute column would need this suite to re-derive the prompt gutter's width and the
 * composer's padding, which is the renderer's own arithmetic restated in the test -- it would agree
 * with the code by construction and prove nothing. An advance needs no such model: whatever the
 * caret's column is for some text, appending one grapheme must move it by exactly that grapheme's
 * cell width, and appending a zero-width mark must not move it at all. The prefixes vary so the
 * advance is measured from ASCII, wide, combining and astral starting columns.
 *
 * THE BOUNDARY CASE:
 * A two-cell glyph cannot occupy the last cell of a row. It has to move whole to the next row
 * rather than split across the edge, and the row it leaves must not report itself wider than the
 * terminal. That case is swept at every offset near the right edge, at odd and even widths, because
 * an even width can hide an off-by-one that an odd width exposes.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * - Whether the caret is on the correct ROW when the composer wraps to several rows. The advance
 *   check asserts the row does not change for text that stays on one row, and the boundary check
 *   asserts the glyph and its trailing character survive, but neither pins a multi-row caret.
 * - Terminal-specific grapheme clustering. Widths come from Bun.stringWidth, so a terminal that
 *   measures an emoji sequence differently is outside this.
 * - Selection, scrolling within the editor, and caret movement by key rather than by text change.
 * - Whether a row the renderer emitted is wider than the terminal. The emulator clips or wraps
 *   every row before the viewport can be read, so a width overrun is invisible to any assertion
 *   made on the painted grid. A suite claiming that invariant was written, swept over 672 states
 *   and deleted, because four product mutations -- visibleWidth counting code units, the pinned
 *   footer under-reserved by a row, the frozen footer region under-reserved by a row, and the
 *   window top shifted up by a row -- all left it green. Catching that class needs the renderer's
 *   emitted bytes, not the emulated result.
 *
 * MUTATION GATE:
 * Short circuiting visibleWidth (packages/tui/src/utils.ts, the single owner of display width) to
 * `return str.length` turns dozens of cases red here, naming the exact arithmetic: "wide cjk: caret
 * advanced 1, expected 2", "combining acute: caret advanced 1, expected 0", "zwj sequence: caret
 * advanced 8, expected 2". It is the only suite in this bucket that detects that mutation.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { initTheme } from "../src/modes/theme/theme";
import { runComposerOracleScenario } from "./helpers/composer-oracle-runner";

/** A grapheme and the number of terminal cells it must occupy. */
interface Grapheme {
	name: string;
	text: string;
	cells: number;
}

/**
 * One of each way width and code-point count disagree: two-cell glyphs, zero-width marks, an
 * astral pair, a joined sequence, and an emoji made wide by a variation selector.
 */
const GRAPHEMES: readonly Grapheme[] = [
	{ name: "ascii letter", text: "a", cells: 1 },
	{ name: "ascii digit", text: "7", cells: 1 },
	{ name: "wide cjk", text: "字", cells: 2 },
	{ name: "wide kana", text: "ア", cells: 2 },
	{ name: "fullwidth space", text: "　", cells: 2 },
	{ name: "astral emoji", text: "\u{1F680}", cells: 2 },
	{ name: "combining acute", text: "\u0301", cells: 0 },
	{ name: "combining diaeresis", text: "\u0308", cells: 0 },
	{ name: "zwj sequence", text: "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}", cells: 2 },
	{ name: "variation selector", text: "\u2764\uFE0F", cells: 2 },
];

/** Starting columns to measure the advance from: empty, ASCII, wide, combining and astral. */
const PREFIXES: readonly string[] = ["", "run ", "実行", "e\u0301", "\u{1F389}"];

/** A two-cell CJK glyph, for the right-edge sweep. */
const WIDE_GLYPH = "字";
/** A two-cell astral emoji, which is also two UTF-16 code units. */
const EMOJI_GLYPH = "\u{1F680}";

/** Odd and even widths, because an even width can hide an off-by-one at the edge. */
const EDGE_WIDTHS: readonly number[] = [20, 21, 30, 31, 40];

const SWEEP_BUDGET_MS = 120_000;

describe("the caret lands where the glyph widths put it", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it(
		"advances by the appended grapheme's cell width, not its code point count",
		async () => {
			const faults: string[] = [];

			for (const prefix of PREFIXES) {
				for (const grapheme of GRAPHEMES) {
					const scenario = await runComposerOracleScenario({
						width: 60,
						height: 12,
						transcriptLines: 6,
						editorText: prefix,
						scrollIsolation: true,
						focused: true,
					});
					try {
						const before = scenario.terminal.getCursor();
						scenario.editor.setText(prefix + grapheme.text);
						await scenario.advance();
						const after = scenario.terminal.getCursor();

						const advance = after.col - before.col;
						if (advance !== grapheme.cells) {
							faults.push(
								`prefix=${JSON.stringify(prefix)} +${grapheme.name}: caret advanced ${advance}, expected ${grapheme.cells}`,
							);
						}
						if (after.row !== before.row) {
							faults.push(
								`prefix=${JSON.stringify(prefix)} +${grapheme.name}: caret changed row ${before.row} to ${after.row} on a single-row composer`,
							);
						}
					} finally {
						scenario.cleanUp();
					}
				}
			}

			expect(faults).toEqual([]);
		},
		SWEEP_BUDGET_MS,
	);

	it(
		"never splits a two-cell glyph across the right edge",
		async () => {
			const faults: string[] = [];

			for (const width of EDGE_WIDTHS) {
				for (const glyph of [WIDE_GLYPH, EMOJI_GLYPH]) {
					const glyphName = glyph === WIDE_GLYPH ? "cjk" : "emoji";
					// Walk the glyph through every offset near the edge, including the single
					// cell where it cannot fit and must move down whole.
					for (let pad = Math.max(0, width - 6); pad <= width + 1; pad += 1) {
						const text = `${"a".repeat(pad)}${glyph}Z`;
						const label = `width=${width} ${glyphName} pad=${pad}`;
						const scenario = await runComposerOracleScenario({
							width,
							height: 10,
							transcriptLines: 4,
							editorText: text,
							scrollIsolation: true,
							focused: true,
						});
						try {
							const rows = scenario.terminal.getViewport().map(row => stripAnsi(row));
							for (let i = 0; i < rows.length; i += 1) {
								const cells = Bun.stringWidth(rows[i]!.replace(/\s+$/, ""));
								if (cells > width)
									faults.push(`${label}: row ${i} is ${cells} cells wide, terminal is ${width}`);
							}
							const painted = rows.join("");
							if (!painted.includes(glyph)) faults.push(`${label}: the glyph is not on the grid`);
							if (!painted.includes("Z")) faults.push(`${label}: the character after the glyph was lost`);
							const caret = scenario.terminal.getCursor();
							if (caret.col < 0 || caret.col >= width) {
								faults.push(`${label}: caret column ${caret.col} is outside [0,${width})`);
							}
						} finally {
							scenario.cleanUp();
						}
					}
				}
			}

			expect(faults).toEqual([]);
		},
		SWEEP_BUDGET_MS,
	);
});
