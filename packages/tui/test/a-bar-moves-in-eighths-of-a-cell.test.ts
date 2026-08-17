// WHY THIS EXISTS.
//
// A bar built from `█` and `░` has exactly one state per column. A ten-column
// bar therefore has ten states: a value that rises by 3% does not move at all,
// and a value that crosses a column jumps a whole cell with nothing in between.
// Every gauge in this product was drawn that way, which is why they read as
// flicking between positions rather than travelling — there was no position
// between two columns for them to be at.
//
// `subCellBar` quantises the fill in eighths across the whole bar and derives
// the cells from that count, so one column carries eight steps. The contract
// this suite defends is that ALL EIGHT of them are reachable, in order, with no
// repeat and no skip, and that the count of filled eighths is a non-decreasing
// function of the ratio — the invariant a bar has to satisfy or it is lying
// about direction. It is asserted by reading the eighth count back OUT of the
// returned string through the exported ramp, never by recomputing it from the
// input, because a test that recomputes the input agrees with any bug that is
// in both places.
//
// The boundary cases are the ones that produce a visibly wrong bar rather than
// a slightly wrong one: a ratio landing exactly on a column must emit no
// partial glyph (`█▏` where `██` is meant reads as a rendering fault), a ratio
// just under a column must keep its `▉` instead of rounding into a column it
// has not reached, and a ramp with no partials — what an ASCII terminal gets,
// since a font without the block glyphs draws a replacement box mid-bar — must
// degrade to whole cells and round to the nearest one rather than truncating.
//
// What it does NOT catch: colour (the caller owns it, and every call site
// slices this string into a fill tone and a track tone), whether a bar is the
// right WIDTH for its row, and whether an animated bar is actually ticked — the
// travel is asserted against the real component in the coding-agent suite
// `a-download-bar-travels-to-its-new-percentage.test.ts`.

import { describe, expect, test } from "bun:test";
import {
	BAR_EIGHTHS_PER_CELL,
	barGlyphEighths,
	EIGHTH_BLOCKS,
	SUB_CELL_BAR_RAMP,
	type SubCellBarRamp,
	subCellBar,
} from "../src/sub-cell-bar";

/** What the product hands an `ascii` symbol preset: no sub-cell glyphs at all. */
const ASCII_RAMP: SubCellBarRamp = { full: "#", track: "-", partials: [] };

/**
 * Filled eighths read back out of a rendered bar, through the ramp that drew
 * it. An unknown glyph fails loudly rather than counting as zero: a bar with a
 * stray character in it is broken, and a lenient reader would call it empty.
 */
function eighthsOf(bar: string, ramp: SubCellBarRamp = SUB_CELL_BAR_RAMP): number {
	let total = 0;
	for (const glyph of bar) {
		const eighths = barGlyphEighths(glyph, ramp);
		if (eighths === undefined) throw new Error(`bar contains a glyph outside its ramp: ${JSON.stringify(glyph)}`);
		total += eighths;
	}
	return total;
}

describe("a bar moves in eighths of a cell", () => {
	test("the ramp is the seven partial blocks, rising, and each maps back to its own eighth", () => {
		expect(EIGHTH_BLOCKS.join("")).toBe("▏▎▍▌▋▊▉");
		expect(BAR_EIGHTHS_PER_CELL - 1).toBe(EIGHTH_BLOCKS.length);
		expect(EIGHTH_BLOCKS.map(glyph => barGlyphEighths(glyph))).toEqual([1, 2, 3, 4, 5, 6, 7]);
		expect(barGlyphEighths("█")).toBe(8);
		expect(barGlyphEighths("░")).toBe(0);
		// Not part of the ramp, so not a bar glyph. `▒` and `▓` are the two the
		// context gauge used to approximate a third and two thirds of a cell with.
		expect(barGlyphEighths("▒")).toBeUndefined();
		expect(barGlyphEighths("▓")).toBeUndefined();
	});

	test("half of ten columns is five filled and five of track", () => {
		expect(subCellBar(0.5, 10)).toBe("█████░░░░░");
	});

	test("both boundaries fill nothing and everything, with no partial cell at either", () => {
		expect(subCellBar(0, 12)).toBe("░░░░░░░░░░░░");
		expect(subCellBar(1, 12)).toBe("████████████");
		// Out of range is the same as the boundary it passed, not an overflow.
		expect(subCellBar(-2, 12)).toBe("░░░░░░░░░░░░");
		expect(subCellBar(4, 12)).toBe("████████████");
	});

	test("a width of zero or less is an empty string, not a stray glyph", () => {
		expect(subCellBar(0.5, 0)).toBe("");
		expect(subCellBar(1, -3)).toBe("");
	});

	/**
	 * The load-bearing test. One column's worth of ratio, sampled at every
	 * eighth, must walk the boundary cell through the whole ramp in order: no
	 * value repeated (a repeat is a step the bar cannot show) and none skipped (a
	 * skip is the jump this replaced).
	 */
	test("one cell's worth of ratio walks the boundary cell through the whole ramp, in order", () => {
		const width = 4;
		// The third cell of four: mid-bar, so this is not an artefact of the ends.
		const cell = 2;
		const observed: string[] = [];
		for (let step = 0; step <= BAR_EIGHTHS_PER_CELL; step++) {
			const bar = subCellBar((cell + step / BAR_EIGHTHS_PER_CELL) / width, width);
			expect(bar.length).toBe(width);
			observed.push(bar[cell] ?? "");
		}
		expect(observed).toEqual(["░", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"]);
		expect(new Set(observed).size).toBe(observed.length);
	});

	test("a single column reaches all eight of its steps", () => {
		const observed = Array.from({ length: BAR_EIGHTHS_PER_CELL }, (_, index) =>
			subCellBar((index + 1) / BAR_EIGHTHS_PER_CELL, 1),
		);
		expect(observed).toEqual(["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"]);
	});

	test("a ratio on a column boundary emits no partial cell", () => {
		// 0.25 of eight columns is exactly two. `██▏░░░░░` would be a bar claiming
		// a fill it does not have.
		expect(subCellBar(0.25, 8)).toBe("██░░░░░░");
		expect(subCellBar(0.75, 8)).toBe("██████░░");
		expect(subCellBar(3 / 8, 8)).toBe("███░░░░░");
	});

	test("a ratio just under a column boundary keeps its seven-eighths instead of rounding up", () => {
		// 31/64 of eight columns is 31 eighths: three whole cells and seven eighths.
		expect(subCellBar(31 / 64, 8)).toBe("███▉░░░░");
		// And just over the previous eighth, so the two are distinguishable at all.
		expect(subCellBar(30 / 64, 8)).toBe("███▊░░░░");
	});

	test("a bar is exactly its width in columns at every eighth of every column", () => {
		for (const width of [1, 7, 12, 28]) {
			for (let step = 0; step <= width * BAR_EIGHTHS_PER_CELL; step++) {
				const bar = subCellBar(step / (width * BAR_EIGHTHS_PER_CELL), width);
				expect(bar.length).toBe(width);
			}
		}
	});

	/**
	 * The invariant. Eight hundred rising ratios, and the fill read back out of
	 * the rendered string never goes backwards. This is what a reader trusts a
	 * bar for: that up means more.
	 */
	test("filled eighths never decrease as the ratio rises, over 801 samples", () => {
		const samples = 801;
		let previous = -1;
		let distinct = 0;
		for (let index = 0; index < samples; index++) {
			const eighths = eighthsOf(subCellBar(index / (samples - 1), 12));
			expect(eighths).toBeGreaterThanOrEqual(previous);
			if (eighths !== previous) distinct++;
			previous = eighths;
		}
		// A 12-column bar has 97 reachable fills (0 through 96 eighths), and 801
		// samples reach every one of them. The old whole-cell bar had 13.
		expect(previous).toBe(12 * BAR_EIGHTHS_PER_CELL);
		expect(distinct).toBe(12 * BAR_EIGHTHS_PER_CELL + 1);
	});

	test("filled eighths track the ratio to within half a step, so the bar is where the number is", () => {
		for (let index = 0; index <= 400; index++) {
			const ratio = index / 400;
			const eighths = eighthsOf(subCellBar(ratio, 12));
			expect(Math.abs(eighths - ratio * 12 * BAR_EIGHTHS_PER_CELL)).toBeLessThanOrEqual(0.5);
		}
	});

	describe("a ramp with no partial glyphs", () => {
		test("draws whole cells only, in the ramp's own glyphs", () => {
			expect(subCellBar(0.5, 10, { ramp: ASCII_RAMP })).toBe("#####-----");
			expect(subCellBar(0, 10, { ramp: ASCII_RAMP })).toBe("----------");
			expect(subCellBar(1, 10, { ramp: ASCII_RAMP })).toBe("##########");
		});

		test("never emits a block glyph, at any eighth of any column", () => {
			for (let step = 0; step <= 80; step++) {
				const bar = subCellBar(step / 80, 10, { ramp: ASCII_RAMP });
				expect(bar).toMatch(/^#*-*$/);
				expect(bar.length).toBe(10);
			}
		});

		test("rounds to the nearest whole cell rather than truncating to zero", () => {
			// 6% of ten columns is 0.6 of a cell. Truncation would report nothing at
			// all for every download under a tenth of the way through.
			expect(subCellBar(0.06, 10, { ramp: ASCII_RAMP })).toBe("#---------");
			expect(subCellBar(0.04, 10, { ramp: ASCII_RAMP })).toBe("----------");
		});

		test("still never lets the fill go backwards as the ratio rises", () => {
			let previous = -1;
			for (let index = 0; index <= 800; index++) {
				const eighths = eighthsOf(subCellBar(index / 800, 10, { ramp: ASCII_RAMP }), ASCII_RAMP);
				expect(eighths).toBeGreaterThanOrEqual(previous);
				previous = eighths;
			}
		});
	});
});
