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
	 * PERF-RENDER-3: setLines is called every frame by the transcript viewer
	 * with the container's memoized render output. Per the render contract,
	 * the same array reference means byte-identical rows, so the same ref must
	 * short-circuit — the defensive copy was the last per-frame cost that
	 * scaled with transcript length instead of viewport height.
	 */
	it("setLines with the identical array reference is a no-op that preserves rendered output", () => {
		const source = ["alpha", "beta", "gamma", "delta"];
		const view = new ScrollView(source, { height: 2, scrollbar: "never", theme });
		view.setScrollOffset(1);
		const before = view.render(10);

		view.setLines(source);
		expect(view.getScrollOffset()).toBe(1);
		expect(view.render(10)).toEqual(before);
	});

	/**
	 * The twin: a NEW array (even with different content length) must still be
	 * adopted fully — the fast path may only trigger on reference identity,
	 * never on shallow equality guesses. Shrinking content must re-clamp.
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
