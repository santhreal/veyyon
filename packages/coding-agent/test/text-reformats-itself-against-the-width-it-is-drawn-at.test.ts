/**
 * WHY:
 * A renderer that has to fit text into a terminal it cannot measure yet used to
 * pick a column count and hope: capping output at 80 threw away two thirds of a
 * wide window. `WidthAwareText` exists so a formatter is asked for its text after
 * the width is known, and its whole value is in the number it hands over. Get
 * that number wrong by the padding and every caller's per-line truncation is off
 * by two columns, which shows up as wrapped rows in a block that promised not to
 * wrap.
 *
 * The class this suite closes: the content width the formatter is asked for
 * disagreeing with the width the inner `Text` actually draws into. The cases
 * below record the widths the formatter was asked for rather than asserting a
 * call happened, sweep the padding and tight-mode combinations that change the
 * budget, and pin the cache's two invalidation causes — a width change and an
 * explicit `invalidate()` — because a cache that never re-formats and one that
 * always re-formats both look correct in a single render.
 *
 * What it does not catch: how the inner `Text` wraps a line the formatter
 * returned longer than the budget, which is `@veyyon/tui`'s contract; and the
 * background and vertical padding, which this component forwards untouched.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { WidthAwareText } from "@veyyon/coding-agent/tui/width-aware-text";
import { setTuiTight } from "@veyyon/utils/tight-mode";

/** A formatter that records every content width it is asked for. */
function recordingFormat(asked: number[], fill = "x"): (contentWidth: number) => string {
	return (contentWidth: number): string => {
		asked.push(contentWidth);
		return fill.repeat(contentWidth);
	};
}

afterEach(() => {
	setTuiTight(false);
});

describe("text reformats itself against the width it is drawn at", () => {
	/**
	 * The number the component exists to compute, over the widths a terminal
	 * actually takes. Padding is charged on both sides, which is the off-by-two
	 * this suite is here for.
	 */
	it("asks the formatter for the width left after padding on both sides", () => {
		const asked: number[] = [];
		const text = new WidthAwareText(recordingFormat(asked), 1);

		for (const width of [20, 40, 80, 120, 200]) text.render(width);

		expect(asked).toEqual([18, 38, 78, 118, 198]);
	});

	it("charges the padding it was constructed with", () => {
		const asked: number[] = [];
		new WidthAwareText(recordingFormat(asked), 3).render(80);
		new WidthAwareText(recordingFormat(asked), 0).render(80);

		expect(asked).toEqual([74, 80]);
	});

	/**
	 * The floor. A pane narrower than its own padding would otherwise ask for a
	 * negative budget, and a formatter handed -2 returns whatever `repeat` throws.
	 * Every width below the floor clamps to the same budget, so the cache answers
	 * all but the first from the one format it already has.
	 */
	it("never asks for less than one column", () => {
		const asked: number[] = [];
		const text = new WidthAwareText(recordingFormat(asked), 2);

		for (const width of [4, 3, 2, 1, 0]) text.render(width);

		expect(asked).toEqual([1]);
	});

	/**
	 * Tight mode is a process-wide flag every surface reads, so the budget has to
	 * follow it: a component that kept the untightened padding would ask for one
	 * column less than the inner `Text` draws into, on every surface at once.
	 */
	it("follows tight mode, and ignores it when told to", () => {
		const tight: number[] = [];
		const ignoring: number[] = [];
		const follows = new WidthAwareText(recordingFormat(tight), 1);
		const ignores = new WidthAwareText(recordingFormat(ignoring), 1).setIgnoreTight(true);

		follows.render(40);
		ignores.render(40);
		setTuiTight(true);
		follows.render(41);
		ignores.render(41);

		expect(tight).toEqual([38, 41]);
		expect(ignoring).toEqual([38, 39]);
	});

	/**
	 * The cache, from both sides. A component that re-formats every frame is a
	 * per-frame allocation in the render loop; one that never re-formats keeps a
	 * narrow terminal's text after the window widens.
	 */
	it("reformats when the width changes and not when it repeats", () => {
		const asked: number[] = [];
		const text = new WidthAwareText(recordingFormat(asked), 1);

		text.render(80);
		text.render(80);
		text.render(100);
		text.render(100);
		text.render(80);

		expect(asked).toEqual([78, 98, 78]);
	});

	it("reformats at an unchanged width after invalidate()", () => {
		const asked: number[] = [];
		const text = new WidthAwareText(recordingFormat(asked), 1);

		text.render(80);
		text.invalidate();
		text.render(80);

		expect(asked).toEqual([78, 78]);
	});

	it("reformats after setIgnoreTight changes the budget", () => {
		const asked: number[] = [];
		const text = new WidthAwareText(recordingFormat(asked), 1);

		text.render(40);
		setTuiTight(true);
		text.setIgnoreTight(true);

		expect(text.render(40)).toHaveLength(3);
		expect(asked).toEqual([38, 38]);
	});

	/**
	 * The promise the number buys: text capped at the budget occupies one row. A
	 * budget one column too generous wraps into a second, which is the failure a
	 * caller sees rather than a wrong integer.
	 */
	it("draws text capped at the budget on one row, and one column more on two", () => {
		const fitting = new WidthAwareText(width => "x".repeat(width), 1, 0);
		const overflowing = new WidthAwareText(width => "x".repeat(width + 1), 1, 0);

		expect(fitting.render(40)).toHaveLength(1);
		expect(overflowing.render(40)).toHaveLength(2);
	});
});
