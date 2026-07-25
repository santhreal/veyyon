/**
 * The tab bar at the widths a real terminal actually reports.
 *
 * A split pane dragged to nothing reports 0 columns. A resize race reports a
 * stale, negative, or NaN width. A miscomputed layout reports Infinity. None of
 * these are theoretical: `component-width-boundary.test.ts` exists because an
 * Infinite width reached `String.prototype.repeat` and threw, taking down the
 * whole frame — and it covered Text and Markdown only, so the tab bar kept its
 * own copy of the same bug in `renderVertical`.
 *
 * Two defects this suite locks out, both found by rendering the component at
 * these widths rather than by reading it:
 *
 *   - `renderVertical(Infinity)` threw `RangeError` from a raw `" ".repeat()`.
 *     A throw in a render path is not a layout bug, it is a crash.
 *   - At zero columns both renderers emitted `…`, because `truncateToWidth`
 *     returns the ellipsis even at width 0. One cell of overrun corrupts every
 *     row to its right, and zero columns means draw nothing.
 *
 * The assertions are on exact bytes and exact visible widths, not on "did not
 * throw": a component that returns a string array of the wrong width has still
 * broken the frame.
 */
import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { type Tab, TabBar, type TabBarTheme } from "@veyyon/tui/components/tab-bar";
import { visibleWidth } from "@veyyon/tui/utils";

/** Unstyled theme, so every assertion is about layout rather than colour. */
const PLAIN_THEME: TabBarTheme = {
	label: t => t,
	activeTab: t => t,
	inactiveTab: t => t,
	hint: t => t,
};

const TABS: Tab[] = [
	{ id: "appearance", label: "Appearance", short: "A" },
	{ id: "model", label: "Model", short: "M" },
	{ id: "interaction", label: "Interaction", short: "I" },
];

/** Widths that break naive layout math, matching the sibling boundary suite. */
const PATHOLOGICAL = [0, -1, -100, Number.NaN, Number.POSITIVE_INFINITY, 1e9, 0x7fff_ffff];

function bar(): TabBar {
	return new TabBar("", TABS, PLAIN_THEME);
}

describe("renderVertical", () => {
	it("does not throw at any pathological width", () => {
		// The regression: `" ".repeat(Infinity)` is a RangeError, and this render
		// path had no `padding()` guard while Text and Markdown did.
		for (const width of PATHOLOGICAL) {
			expect(() => bar().renderVertical(width)).not.toThrow();
		}
	});

	it("draws exactly the requested columns, cursor included", () => {
		// 14 columns fits "> " plus "Appearance" with two to spare, so the padded
		// row is the whole contract in one assertion.
		const lines = bar().renderVertical(14, "> ");

		expect(stripVTControlCharacters(lines[0]!)).toBe("> Appearance  ");
		expect(stripVTControlCharacters(lines[1]!)).toBe("  Model       ");
		expect(stripVTControlCharacters(lines[2]!)).toBe("  Interaction ");
	});

	it("falls back to the short label rather than clipping the name", () => {
		// At 5 columns "Appearance" cannot fit beside the cursor. Cutting it to
		// "App" would read as a different tab; the short form is deliberate.
		const lines = bar().renderVertical(5, "> ");

		expect(stripVTControlCharacters(lines[0]!)).toBe("> A  ");
		expect(stripVTControlCharacters(lines[2]!)).toBe("  I  ");
	});

	it("pads every row to the same width so a full-width highlight has a bar to paint", () => {
		// The active row's background paints across the padded cells. Ragged rows
		// would give the selected tab a torn right edge.
		for (const width of [3, 7, 14, 40]) {
			for (const line of bar().renderVertical(width)) {
				expect(visibleWidth(stripVTControlCharacters(line))).toBe(width);
			}
		}
	});

	it("draws nothing at zero columns instead of one cell of ellipsis", () => {
		expect(bar().renderVertical(0)).toEqual([""]);
	});

	it("treats a negative or NaN width as zero", () => {
		// A stale resize event is not a request for one column of output.
		for (const width of [-1, -100, Number.NaN]) {
			expect(bar().renderVertical(width)).toEqual([""]);
		}
	});

	it("bounds a huge width rather than allocating it", () => {
		// `padding()` caps its output; the row must stay a string, not a gigabyte.
		const lines = bar().renderVertical(1e9);

		expect(lines.length).toBe(TABS.length);
		for (const line of lines) expect(line.length).toBeLessThan(1e7);
	});
});

describe("render (horizontal)", () => {
	it("does not throw at any pathological width", () => {
		for (const width of PATHOLOGICAL) {
			expect(() => bar().render(width)).not.toThrow();
		}
	});

	it("draws nothing at zero columns", () => {
		expect(bar().render(0)).toEqual([""]);
	});

	it("never overruns the width it was given", () => {
		// The failure this catches is silent: one cell of overrun shifts every
		// character to the right of the bar by one for the rest of the frame.
		for (const width of [1, 2, 3, 5, 13, 40, 200]) {
			for (const line of bar().render(width)) {
				expect(visibleWidth(stripVTControlCharacters(line))).toBeLessThanOrEqual(width);
			}
		}
	});

	it("keeps every tab reachable by mouse after collapsing to short labels", () => {
		// Collapse rewrites the labels; hit zones are rebuilt from the same pass,
		// so a collapse that forgot them would leave tabs clickable at stale
		// columns — visible only as clicks selecting the wrong tab.
		const b = bar();
		b.render(12);

		const hit = b.tabAt(0, 1);
		expect(hit).toBeDefined();
		expect(TABS.some(t => t.id === hit!.id)).toBe(true);
	});
});
