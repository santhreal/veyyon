import { describe, expect, it } from "bun:test";
import { ScrollView } from "@veyyon/tui/components/scroll-view";
import { Ellipsis, visibleWidth } from "@veyyon/tui/utils";

const theme = {
	track: () => "T",
	thumb: () => "B",
};

describe("ScrollView", () => {
	it("renders a fixed-height viewport and omits auto scrollbar when content fits", () => {
		const view = new ScrollView(["one", "two"], { height: 3, theme });

		expect(view.render(10)).toEqual(["one", "two", ""]);
	});

	// The bar band is two columns: a breathing-space gap + the bar glyph, so
	// right-aligned content never touches the scrollbar.
	it("renders a right-edge scrollbar when content overflows", () => {
		const view = new ScrollView(["alpha", "beta", "gamma", "delta", "omega"], { height: 3, theme });

		expect(view.render(6)).toEqual(["alp… B", "beta T", "gam… T"]);
	});

	it("scrolls and clamps offsets", () => {
		const view = new ScrollView(["one", "two", "three", "four", "five"], { height: 3, theme });

		view.scroll(10);

		expect(view.getScrollOffset()).toBe(2);
		expect(view.render(6)).toEqual(["thr… T", "four T", "five B"]);

		view.scroll(-10);

		expect(view.getScrollOffset()).toBe(0);
	});

	it("reserves a scrollbar column in always mode", () => {
		const view = new ScrollView(["one"], { height: 2, scrollbar: "always", theme });

		expect(view.render(5)).toEqual(["one B", "    B"]);
	});

	it("does not reserve a scrollbar column in never mode", () => {
		const view = new ScrollView(["alpha", "beta", "gamma"], { height: 2, scrollbar: "never", theme });

		expect(view.render(6)).toEqual(["alpha", "beta"]);
	});

	it("renders scrollbar geometry for pre-windowed lines", () => {
		const view = new ScrollView(["gamma", "delta"], { height: 2, totalRows: 4, theme });
		view.setScrollOffset(2);

		expect(view.render(6)).toEqual(["gam… T", "del… B"]);
	});

	it("does not render a scrollbar when width is zero", () => {
		const view = new ScrollView(["one", "two"], { height: 1, theme });

		expect(view.render(0)).toEqual([""]);
	});

	it("clamps scroll offset when content shrinks", () => {
		const view = new ScrollView(["one", "two", "three", "four"], { height: 2, theme });
		view.scrollToBottom();

		view.setLines(["one"]);

		expect(view.getScrollOffset()).toBe(0);
		expect(view.render(10)).toEqual(["one", ""]);
	});

	it("keeps rendered rows within requested width with ANSI input", () => {
		const view = new ScrollView(["\x1b[31malphabet\x1b[0m", "plain", "tail"], { height: 2, theme });
		const rendered = view.render(5);

		expect(rendered).toHaveLength(2);
		expect(rendered.every(line => visibleWidth(line) <= 5)).toBe(true);
		expect(rendered[0]).toContain("B");
	});

	it("appends an overflow ellipsis by default and omits it when configured", () => {
		const long = ["abcdefghij"];
		const def = new ScrollView(long, { height: 1, scrollbar: "never", theme });
		expect(def.render(5)[0]).toContain("…");

		const omit = new ScrollView(long, { height: 1, scrollbar: "never", ellipsis: Ellipsis.Omit, theme });
		expect(omit.render(5)[0]).toBe("abcde");
	});

	it("handles navigation keys, with Shift+Arrow scrolling by fastScrollLines", () => {
		const view = new ScrollView(
			Array.from({ length: 50 }, (_, i) => String(i)),
			{ height: 5, fastScrollLines: 7, theme },
		);

		expect(view.handleScrollKey("\x1b[B")).toBe(true); // down
		expect(view.getScrollOffset()).toBe(1);
		expect(view.handleScrollKey("\x1b[1;2B")).toBe(true); // shift+down
		expect(view.getScrollOffset()).toBe(8);
		expect(view.handleScrollKey("\x1b[1;2A")).toBe(true); // shift+up
		expect(view.getScrollOffset()).toBe(1);
		expect(view.handleScrollKey("x")).toBe(false);
	});

	/**
	 * Regression lock (2026-07-24): a same-reference setLines MUST re-copy the
	 * rows. Transcript components mutate their previously returned render
	 * arrays in place (streaming row caches), so a reference-identity fast
	 * path serves stale rows — the agent-hub transcript tail froze mid-stream
	 * exactly that way. setLines takes content by value, always.
	 */
	it("setLines with the same array reference adopts in-place mutations of its contents", () => {
		const source = ["alpha", "beta"];
		const view = new ScrollView(source, { height: 2, scrollbar: "never", theme });
		expect(view.render(10)).toEqual(["alpha", "beta"]);

		// Stay under the render width (10 cols): this test is about adoption of
		// the mutation, not truncation.
		source[1] = "BETA-EDIT";
		view.setLines(source);
		expect(view.render(10)).toEqual(["alpha", "BETA-EDIT"]);
	});

	/**
	 * A new array (even with different content length) is adopted fully and
	 * shrinking content re-clamps the scroll offset.
	 */
	it("setLines with a new array reference adopts the new content and re-clamps", () => {
		const view = new ScrollView(["a", "b", "c", "d", "e"], { height: 2, scrollbar: "never", theme });
		view.scrollToBottom();
		expect(view.getScrollOffset()).toBe(3);

		view.setLines(["x", "y"]);
		expect(view.getScrollOffset()).toBe(0);
		expect(view.render(5)).toEqual(["x", "y"]);
	});
});

/**
 * `contentWidth`: how much room a caller actually has to draw in.
 *
 * WHY IT IS PUBLIC. Callers that FILL a row (a selection highlight, a header
 * band) have to know where to stop. Padding to the width passed to `render`
 * overruns the scrollbar band, and `render` then truncates the line to make room
 * for the bar, cutting whatever escape closed the fill: the bar and every cell
 * after it come out painted, with nothing left to turn the colour off. Two
 * copies of the "reserve two columns" rule drift the same way, one silently.
 */
describe("ScrollView.contentWidth", () => {
	/** Content that fits keeps the whole width: there is no bar to make room for. */
	it("reserves nothing when the content fits the viewport", () => {
		const view = new ScrollView(["one", "two"], { height: 3, theme });

		expect(view.contentWidth(20)).toBe(20);
	});

	/** Overflowing content loses the gap plus the bar glyph, which is two columns. */
	it("reserves the gap and the bar when the content overflows", () => {
		const view = new ScrollView(["one", "two", "three", "four"], { height: 2, theme });

		expect(view.contentWidth(20)).toBe(18);
	});

	/** `always` reserves even when everything fits, because the bar is drawn anyway. */
	it("reserves for a scrollbar that is pinned on", () => {
		const view = new ScrollView(["one"], { height: 3, scrollbar: "always", theme });

		expect(view.contentWidth(20)).toBe(18);
	});

	/** `never` reserves nothing however far the content overflows. */
	it("reserves nothing for a scrollbar that is turned off", () => {
		const view = new ScrollView(["one", "two", "three", "four"], { height: 1, scrollbar: "never", theme });

		expect(view.contentWidth(20)).toBe(20);
	});

	/** It answers for the width asked about, not for the last width rendered. */
	it("answers for the width it is given", () => {
		const view = new ScrollView(["one", "two", "three"], { height: 1, theme });

		expect(view.contentWidth(40)).toBe(38);
		expect(view.contentWidth(8)).toBe(6);
	});

	/** A width of zero has nothing to reserve from, and must not go negative. */
	it("never returns a negative width", () => {
		const view = new ScrollView(["one", "two", "three"], { height: 1, theme });

		expect(view.contentWidth(0)).toBe(0);
		expect(view.contentWidth(1)).toBe(0);
	});

	/**
	 * The point of the whole method: a line padded to `contentWidth` reaches
	 * `render` intact. Padded to the full width instead, it is truncated, and the
	 * ellipsis lands where the caller's trailing style should have been.
	 */
	it("keeps a line padded to it from being truncated", () => {
		const view = new ScrollView([], { height: 2, totalRows: 9, theme });
		const width = 12;
		const padded = `ab${" ".repeat(view.contentWidth(width) - 2)}`;
		view.setLines([padded, padded]);

		const rendered = view.render(width);

		expect(rendered[0]).toBe(`${padded} B`);
		expect(visibleWidth(rendered[0])).toBe(width);
	});
});
