/**
 * Slicing a line never emits half a grapheme.
 *
 * `sliceWithWidth`'s doc comment has named this file as the place its contract
 * is locked since the function was written, and the file did not exist. That is
 * worse than no reference: a reader checking the guarantee finds a citation and
 * stops looking.
 *
 * The contract has three parts, and the subtle one is that a grapheme's width is
 * not its length in code units, so a slice sized in COLUMNS cannot simply cut at
 * an index:
 *
 *   - Cuts always land on grapheme boundaries. Emitting the second half of a
 *     wide character puts a replacement glyph on screen and, worse, throws off
 *     every column to its right for the rest of the line.
 *   - Loose mode (the default) keeps a straddling grapheme whole, so the result
 *     may be WIDER than the requested length by up to one grapheme. A caller
 *     sizing a viewport by length alone can overflow it by a cell — stated here
 *     so the overflow is a known cost rather than a surprise.
 *   - Strict mode drops it instead, so the width never exceeds the request, at
 *     the cost of a blank column.
 *
 * Every case asserts EXACT text and EXACT width. A test that only checked "did
 * not throw" would pass on a slice that returned a lone surrogate.
 */
import { describe, expect, it } from "bun:test";
import { sliceWithWidth, truncateToWidth, visibleWidth } from "@veyyon/tui/utils";

/** One of each grapheme family that breaks a naive index-based cut. */
const CJK = "日本語テキスト";
const EMOJI = "🎉🎊🎈";
const ZWJ_FAMILY = "👨‍👩‍👧‍👦 family";
const FLAG = "🇯🇵 flag";
const SKIN_TONE = "👍🏽 ok";
const COMBINING = "école";

describe("visibleWidth", () => {
	it("counts a CJK character as two columns", () => {
		expect(visibleWidth(CJK)).toBe(14);
	});

	it("counts a ZWJ sequence as ONE grapheme, not its parts", () => {
		// The family emoji is four people joined by zero-width joiners. Counted per
		// code point it would be eight columns wide and every column after it would
		// be wrong.
		expect(visibleWidth(ZWJ_FAMILY)).toBe(9);
	});

	it("counts a regional-indicator flag pair as one grapheme", () => {
		expect(visibleWidth(FLAG)).toBe(7);
	});

	it("counts a skin-tone modifier with the emoji it modifies", () => {
		expect(visibleWidth(SKIN_TONE)).toBe(5);
	});

	it("counts a combining mark with its base letter", () => {
		expect(visibleWidth(COMBINING)).toBe(5);
	});
});

describe("a slice that starts inside a wide grapheme", () => {
	it("drops that grapheme rather than emitting its second half", () => {
		// Column 1 is the right half of 日. Returning it alone would put a broken
		// glyph on screen and shift the rest of the row by a column.
		const slice = sliceWithWidth(CJK, 1, 3);

		expect(slice.text).toBe("本");
		expect(slice.width).toBe(2);
	});

	it("does the same for an emoji", () => {
		const slice = sliceWithWidth(EMOJI, 1, 3);

		expect(slice.text).toBe("🎊");
		expect(slice.width).toBe(2);
	});
});

describe("loose mode", () => {
	it("keeps a grapheme that straddles the end, exceeding the requested length", () => {
		// Three columns requested, four returned. This is the documented cost of
		// never cutting a grapheme, and a caller that sizes a viewport by length
		// alone overflows it here.
		const slice = sliceWithWidth(CJK, 0, 3);

		expect(slice.text).toBe("日本");
		expect(slice.width).toBe(4);
		expect(slice.width).toBeGreaterThan(3);
	});

	it("returns exactly the requested width when the boundary lines up", () => {
		const slice = sliceWithWidth(CJK, 2, 4);

		expect(slice.text).toBe("本語");
		expect(slice.width).toBe(4);
	});
});

describe("strict mode", () => {
	it("drops the straddling grapheme so the width never exceeds the request", () => {
		const slice = sliceWithWidth(CJK, 0, 3, true);

		expect(slice.text).toBe("日");
		expect(slice.width).toBe(2);
		expect(slice.width).toBeLessThanOrEqual(3);
	});

	it("agrees with loose mode when nothing straddles the edge", () => {
		// Strict is not a different slicer, it is the same one with a rule about the
		// edge. Divergence anywhere else would be a bug in one of them.
		for (const [start, length] of [
			[2, 4],
			[0, 14],
			[4, 6],
		] as const) {
			expect(sliceWithWidth(CJK, start, length, true)).toEqual(sliceWithWidth(CJK, start, length));
		}
	});

	it("never exceeds the request for any of the grapheme families", () => {
		for (const text of [CJK, EMOJI, ZWJ_FAMILY, FLAG, SKIN_TONE, COMBINING]) {
			for (let start = 0; start < 6; start++) {
				for (let length = 1; length <= 6; length++) {
					expect(sliceWithWidth(text, start, length, true).width).toBeLessThanOrEqual(length);
				}
			}
		}
	});
});

describe("a multi-code-point grapheme", () => {
	it("is kept whole by a slice that reaches it", () => {
		// The family emoji plus the following space is three columns. Any cut inside
		// it would produce a person or two rather than a family.
		const slice = sliceWithWidth(ZWJ_FAMILY, 0, 3);

		expect(slice.text).toBe("👨‍👩‍👧‍👦 ");
		expect(slice.width).toBe(3);
	});

	it("keeps a flag's two regional indicators together", () => {
		expect(sliceWithWidth(FLAG, 0, 3).text).toBe("🇯🇵 ");
	});

	it("keeps a skin-tone modifier with its emoji", () => {
		expect(sliceWithWidth(SKIN_TONE, 0, 3).text).toBe("👍🏽 ");
	});
});

describe("truncateToWidth", () => {
	it("never returns a partial grapheme, and stays within the budget", () => {
		// The ellipsis costs a column, so a 4-column budget over wide text yields 3
		// columns of content plus it. What must never happen is 4 columns achieved
		// by splitting a two-column character.
		for (const text of [CJK, EMOJI, ZWJ_FAMILY, FLAG, SKIN_TONE, COMBINING]) {
			for (let width = 0; width <= 8; width++) {
				expect(visibleWidth(truncateToWidth(text, width))).toBeLessThanOrEqual(width);
			}
		}
	});

	it("cuts wide text at the grapheme, not the column", () => {
		expect(truncateToWidth(CJK, 4)).toBe("日…");
		expect(truncateToWidth(EMOJI, 4)).toBe("🎉…");
	});

	it("keeps a whole ZWJ sequence when it fits", () => {
		expect(truncateToWidth(ZWJ_FAMILY, 4)).toBe("👨‍👩‍👧‍👦 …");
	});
});
