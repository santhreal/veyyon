/**
 * The display tab width is one number on both sides of the FFI boundary.
 *
 * WHY THIS SUITE EXISTS. Two independent implementations answer "how many columns does a tab
 * draw". `visibleWidth` in `packages/tui/src/utils.ts` charges `DEFAULT_TAB_WIDTH` per tab in
 * JavaScript, and every cut, slice, wrap and overlay goes through `crates/veyyon-text`, which
 * takes the width as an argument and CLAMPS it to its own private `MIN_TAB_WIDTH..MAX_TAB_WIDTH`
 * before using it. The JS side does no such clamp on the number it measures with: it is a plain
 * exported constant in `@veyyon/utils/tab-spacing`.
 *
 * So the two agree only while the JS default happens to sit inside a range declared in Rust and
 * invisible from here. Raise the JS constant past the native maximum and nothing fails: the
 * native keeps cutting at the clamped width while the JS oracle measures at the raised one, and
 * every span cut to fit W re-measures as wider than W. That is the overflow class the compositor
 * cannot survive, because it sizes viewports by those cuts.
 *
 * The bounds themselves are NOT the shared value. `MIN_TAB_WIDTH`/`MAX_TAB_WIDTH` in
 * `@veyyon/utils/tab-spacing` clamp an `.editorconfig`-derived `tab_size` on its way to an LSP
 * formatting request and never reach a native text op. The number that crosses the boundary is
 * the display default, so that is what these cases pin, through each of the five ops that carry
 * it across.
 */

import { describe, expect, it } from "bun:test";
import { visibleWidth as nativeVisibleWidth } from "@veyyon/natives";
import {
	DEFAULT_TAB_WIDTH,
	Ellipsis,
	extractSegments,
	sliceWithWidth,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@veyyon/tui";

const TAB = "\t";

describe("a tab measures the same width in the JS oracle and in every native op", () => {
	it("charges one tab stop in both width oracles", () => {
		expect(visibleWidth(TAB)).toBe(DEFAULT_TAB_WIDTH);
		expect(nativeVisibleWidth(TAB, DEFAULT_TAB_WIDTH)).toBe(DEFAULT_TAB_WIDTH);
	});

	/**
	 * A cut at exactly one tab stop keeps the tab and drops what follows. With the JS default
	 * above the native clamp the native would think the tab narrower than the JS oracle does and
	 * keep the following character too.
	 */
	it("cuts a tab-led line at one tab stop", () => {
		expect(truncateToWidth(`${TAB}x`, DEFAULT_TAB_WIDTH, Ellipsis.Omit)).toBe(TAB);
		expect(truncateToWidth(`${TAB}x`, DEFAULT_TAB_WIDTH + 1, Ellipsis.Omit)).toBe(`${TAB}x`);
	});

	it("slices a tab-led line at one tab stop", () => {
		const slice = sliceWithWidth(`${TAB}x`, 0, DEFAULT_TAB_WIDTH);
		expect({ text: slice.text, width: slice.width }).toEqual({ text: TAB, width: DEFAULT_TAB_WIDTH });
	});

	it("wraps one tab per row at a one-tab-stop width", () => {
		expect(wrapTextWithAnsi(`${TAB}${TAB}`, DEFAULT_TAB_WIDTH)).toEqual([TAB, TAB]);
	});

	it("ends the before-segment of an overlay at one tab stop", () => {
		const segments = extractSegments(`${TAB}xy`, DEFAULT_TAB_WIDTH, DEFAULT_TAB_WIDTH + 1, 1, false);
		expect({ before: segments.before, beforeWidth: segments.beforeWidth }).toEqual({
			before: TAB,
			beforeWidth: DEFAULT_TAB_WIDTH,
		});
		expect(segments.after).toBe("y");
	});

	/**
	 * The property the divergence breaks, stated directly: whatever the native cut to fit a
	 * width, the JS oracle must not measure as wider than that width. Swept across every width
	 * around three tab stops, because a disagreement only shows at the widths where the two
	 * answers put the cut in different places.
	 */
	it("never re-measures a native cut as wider than the width it was cut to", () => {
		const tabs = TAB.repeat(4);
		for (let width = 0; width <= 4 * DEFAULT_TAB_WIDTH + 2; width++) {
			const cut = truncateToWidth(tabs, width, Ellipsis.Omit);
			expect(visibleWidth(cut), `cut of ${tabs.length} tabs to ${width} columns`).toBeLessThanOrEqual(width);
		}
	});
});
