import { describe, expect, it } from "bun:test";
import { padLineToWidth, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@veyyon/tui";

/**
 * A grapheme is the unit the terminal draws, and every column calculation has to
 * agree on how wide it is and refuse to cut it in half.
 *
 * WHY THIS SUITE EXISTS (TUI-2). Column math is the one arithmetic in a TUI that
 * a reader can see going wrong. Get a width by one cell and a box border lands
 * inside the text; cut a ZWJ sequence at a joiner and a family emoji becomes
 * four separate people; split a regional-indicator pair and a flag becomes two
 * letter boxes. None of these throw, so nothing catches them except an assertion
 * on the exact number of cells.
 *
 * Four functions have to answer consistently, because a rendered row passes
 * through all of them: `visibleWidth` measures, `sliceByColumn` extracts a
 * column range, `truncateToWidth` fits, and `wrapTextWithAnsi` breaks. A
 * disagreement between any two of them is a layout bug, so the cases below run
 * the same strings through each.
 *
 * The wrap cases carry a specific regression. `break_long_word` in
 * `crates/veyyon-natives/src/text.rs` gated its line break on "this grapheme
 * does not fit" without also asking "does this line already hold anything". A
 * grapheme wider than the target width fails that test on an empty line, so the
 * empty line was emitted and the grapheme placed after it: wrapping "漢漢" to
 * width 1 returned four rows, two of them blank. A caller sizing a viewport from
 * the row count reserved space for content that does not exist.
 */

/** Family: four emoji joined by ZWJ. One grapheme, two cells, eleven code units. */
const FAMILY = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}";
/** Japan: two regional indicators. One grapheme, two cells. */
const FLAG = "\u{1F1EF}\u{1F1F5}";
/** Thumbs up with a skin-tone modifier. One grapheme, two cells. */
const SKIN_TONE = "\u{1F44D}\u{1F3FD}";
/** Heart with VS16, which promotes the narrow U+2764 to an emoji presentation. */
const HEART_VS16 = "❤️";
/** A base letter carrying three stacked combining marks. One grapheme, one cell. */
const STACKED = "é̂̃";
/** A Devanagari cluster: consonant, virama, consonant, vowel sign. */
const DEVANAGARI = "क्षि";

describe("a grapheme measures the cells it actually occupies", () => {
	/**
	 * CJK is the base case for double width and the one every box-drawing
	 * calculation depends on.
	 */
	it("measures a CJK ideograph at 2 cells", () => {
		expect(visibleWidth("漢")).toBe(2);
		expect(visibleWidth("漢字")).toBe(4);
	});

	/**
	 * A ZWJ sequence is ONE grapheme however many code points it holds. Measuring
	 * it per code point gives 8 cells for something the terminal draws in 2, which
	 * is the error that pushes a table column four characters out of line.
	 */
	it("measures a four-person ZWJ family at 2 cells, not once per person", () => {
		expect(FAMILY.length).toBe(11);
		expect(visibleWidth(FAMILY)).toBe(2);
	});

	/** A flag is two code points and one drawn glyph. */
	it("measures a regional-indicator flag at 2 cells", () => {
		expect(visibleWidth(FLAG)).toBe(2);
	});

	/** A skin-tone modifier attaches to the base emoji rather than adding a cell. */
	it("measures a skin-tone modified emoji at 2 cells", () => {
		expect(visibleWidth(SKIN_TONE)).toBe(2);
	});

	/**
	 * VS16 changes presentation and therefore width. The bare character is narrow
	 * text and the sequence is a wide emoji, so a measurement that ignores the
	 * selector is off by one for every heart in the output.
	 */
	it("measures a VS16 emoji at 2 cells and its bare base at 1", () => {
		expect(visibleWidth("❤")).toBe(1);
		expect(visibleWidth(HEART_VS16)).toBe(2);
	});

	/** Combining marks draw on top of the base and add no cells of their own. */
	it("measures stacked combining marks as a single cell", () => {
		expect(STACKED.length).toBe(4);
		expect(visibleWidth(STACKED)).toBe(1);
	});

	/** A lone combining mark occupies nothing. */
	it("measures a lone combining mark at 0 cells", () => {
		expect(visibleWidth("́")).toBe(0);
	});
});

describe("slicing never cuts a grapheme in half", () => {
	/**
	 * Strict mode is what a fixed-width region uses, and it must exclude a wide
	 * character that would spill past the boundary rather than hand back a row one
	 * cell too long.
	 */
	it("excludes a wide char that would overrun the requested columns", () => {
		const slice = sliceByColumn("漢字漢", 0, 3, true);

		expect(slice).toBe("漢");
		expect(visibleWidth(slice)).toBe(2);
	});

	/**
	 * A ZWJ sequence is indivisible, so a 1-column strict request can hold none of
	 * it. Returning half the sequence would render as separate people.
	 */
	it("returns nothing rather than half a ZWJ sequence", () => {
		expect(sliceByColumn(FAMILY, 0, 1, true)).toBe("");
	});

	/** Same contract for a flag: half a flag is two letter boxes. */
	it("returns nothing rather than one half of a flag", () => {
		expect(sliceByColumn(FLAG, 0, 1, true)).toBe("");
	});

	/**
	 * A start column landing on the second cell of a wide character cannot include
	 * that character, so the slice begins at the next one.
	 */
	it("starts at the next grapheme when startCol lands inside a wide char", () => {
		expect(sliceByColumn("漢字", 1, 2)).toBe("字");
	});

	/** Strict mode at that same interior column has no room at all. */
	it("returns nothing in strict mode when startCol lands inside a wide char", () => {
		expect(sliceByColumn("漢字", 1, 2, true)).toBe("");
	});

	/** A range beyond the end is empty, not a crash and not the whole string. */
	it("returns nothing for a range past the end of the line", () => {
		expect(sliceByColumn("漢", 5, 2)).toBe("");
	});

	/** A length past the end yields what is there. */
	it("returns the whole line when the range exceeds its width", () => {
		expect(sliceByColumn("漢", 0, 10)).toBe("漢");
	});
});

describe("truncation fits the budget and keeps graphemes whole", () => {
	/**
	 * The ellipsis costs a cell, so a 3-cell budget holds one 2-cell ideograph and
	 * the marker. Asserting the exact result rather than a length bound is what
	 * catches an off-by-one in the ellipsis accounting.
	 */
	it("keeps one wide char plus the ellipsis within 3 cells", () => {
		const truncated = truncateToWidth("漢字漢", 3);

		expect(truncated).toBe("漢…");
		expect(visibleWidth(truncated)).toBe(3);
	});

	/**
	 * A budget too small for both a wide char and the marker keeps the marker.
	 * Dropping the marker instead would hide that anything was cut.
	 */
	it("keeps the ellipsis alone when a wide char cannot also fit", () => {
		expect(truncateToWidth("漢字漢", 2)).toBe("…");
		expect(truncateToWidth("漢字漢", 1)).toBe("…");
	});

	/** A zero budget produces nothing at all, not a bare marker. */
	it("produces nothing at a zero budget", () => {
		expect(truncateToWidth("漢字漢", 0)).toBe("");
	});

	/** A ZWJ sequence is dropped whole or kept whole, never partially. */
	it("keeps a ZWJ sequence whole when truncating", () => {
		expect(truncateToWidth(FAMILY.repeat(3), 3)).toBe(`${FAMILY}…`);
	});
});

describe("padding produces exactly the requested width", () => {
	/**
	 * A wide character can leave the truncated content one cell short of the
	 * target, so the pad has to be computed from the truncated width rather than
	 * from the input length. A row that is one cell short breaks the column to its
	 * right for the whole height of the frame.
	 */
	it("pads a wide-char line that truncated one cell short", () => {
		expect(visibleWidth(padLineToWidth("漢漢", 3))).toBe(3);
	});

	/** The same guarantee holds for a ZWJ sequence. */
	it("pads a ZWJ line to exactly the requested width", () => {
		expect(visibleWidth(padLineToWidth(FAMILY, 5))).toBe(5);
	});

	/** And for a line that already fits. */
	it("pads an ordinary line to exactly the requested width", () => {
		expect(visibleWidth(padLineToWidth("ab", 6))).toBe(6);
	});
});

describe("wrapping a grapheme wider than the column", () => {
	/**
	 * THE REGRESSION. Wrapping two ideographs to width 1 returned four rows, the
	 * first and last blank. A grapheme that cannot fit has to overflow because it
	 * is indivisible, and putting it alone on its own row is the only answer that
	 * does not invent rows.
	 */
	it("returns one row per grapheme with no blank rows", () => {
		expect(wrapTextWithAnsi("漢漢", 1)).toEqual(["漢", "漢"]);
	});

	/** Longer input makes the invented rows accumulate, so it is asserted too. */
	it("returns one row per grapheme for a longer run", () => {
		expect(wrapTextWithAnsi("漢漢漢", 1)).toEqual(["漢", "漢", "漢"]);
	});

	/**
	 * Width 0 is a real state: a pane collapsed to nothing is still asked to
	 * render. Every grapheme is oversized there, which is the case that used to
	 * blank-line between all of them.
	 */
	it("returns one row per grapheme at width 0", () => {
		expect(wrapTextWithAnsi("ab", 0)).toEqual(["a", "b"]);
	});

	/** A ZWJ sequence overflows whole rather than breaking at a joiner. */
	it("keeps a ZWJ sequence on one row when it cannot fit", () => {
		expect(wrapTextWithAnsi(FAMILY, 1)).toEqual([FAMILY]);
	});

	/** A flag likewise overflows whole. */
	it("keeps a flag on one row when it cannot fit", () => {
		expect(wrapTextWithAnsi(FLAG, 1)).toEqual([FLAG]);
	});

	/**
	 * The overflow is confined to the grapheme that caused it. A narrow character
	 * following an over-budget row starts a new one instead of riding along.
	 */
	it("does not pack a narrow char onto a row that already overflowed", () => {
		expect(wrapTextWithAnsi("漢a", 1)).toEqual(["漢", "a"]);
	});

	/** The mirror ordering breaks in the same place. */
	it("breaks between a narrow char and an oversized one", () => {
		expect(wrapTextWithAnsi("a漢", 1)).toEqual(["a", "漢"]);
	});
});

describe("wrapping still breaks where it always did", () => {
	/**
	 * THE NECESSARY TWIN. A fix that simply stopped breaking would satisfy every
	 * assertion above, so the ordinary breaks are asserted just as exactly.
	 */
	it("breaks CJK at the column boundary when the graphemes fit", () => {
		expect(wrapTextWithAnsi("漢漢漢", 2)).toEqual(["漢", "漢", "漢"]);
		expect(wrapTextWithAnsi("漢漢漢", 4)).toEqual(["漢漢", "漢"]);
	});

	/** ASCII takes a separate branch in the native breaker and is unchanged. */
	it("breaks a long ASCII word at the column boundary", () => {
		expect(wrapTextWithAnsi("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
	});

	/** Every produced row stays within the width when the content can fit. */
	it("keeps every row within the width for mixed content that fits", () => {
		for (const line of wrapTextWithAnsi(`a漢b${FAMILY}c`, 4)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(4);
		}
	});

	/** Empty input still yields one empty row, which is what a blank line is. */
	it("returns a single empty row for empty input", () => {
		expect(wrapTextWithAnsi("", 4)).toEqual([""]);
	});
});

describe("a Devanagari cluster is one grapheme", () => {
	/**
	 * Indic clusters are the case that most often exposes a per-code-point loop:
	 * consonant, virama, consonant, vowel sign draw as one unit, and splitting
	 * between them leaves a bare virama on a row.
	 */
	it("measures the cluster as a unit rather than per code point", () => {
		expect(DEVANAGARI.length).toBe(4);
		expect(visibleWidth(DEVANAGARI)).toBeLessThanOrEqual(2);
	});

	/** Slicing keeps the cluster whole. */
	it("does not split the cluster when slicing", () => {
		expect(sliceByColumn(DEVANAGARI, 0, 2)).toBe(DEVANAGARI);
	});
});
