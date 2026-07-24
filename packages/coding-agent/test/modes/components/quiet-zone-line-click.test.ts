/**
 * QuietZoneLine click plumbing (GMI-2b).
 *
 * Why this suite exists: the footline component indents its content off the
 * terminal's left edge, but the segment hit-test (quietSegmentAt) works in the
 * line provider's own coordinates. If routeMouse forgot to subtract the indent
 * actually applied on the last render — which can be smaller than the
 * configured indent on narrow widths — every click would resolve one indent's
 * worth of columns to the wrong segment. These tests lock the subtraction,
 * the left-click-only filter, and that clicks inside the indent gutter never
 * reach the handler.
 */
import { describe, expect, it } from "bun:test";
import type { SgrMouseEvent } from "@veyyon/tui";
import { QuietZoneLine } from "../../../src/modes/components/composer-chrome";

function click(col: number, overrides: Partial<SgrMouseEvent> = {}): SgrMouseEvent {
	return {
		button: 0,
		col,
		row: 0,
		release: false,
		wheel: null,
		motion: false,
		leftClick: true,
		...overrides,
	};
}

describe("QuietZoneLine click routing", () => {
	it("subtracts the applied indent so the handler sees provider-space columns", () => {
		const line = new QuietZoneLine(() => "content", 3);
		const seen: number[] = [];
		line.onClick = col => seen.push(col);
		line.render(80);

		line.routeMouse(click(3), 0, 3); // first content column
		line.routeMouse(click(10), 0, 10);
		expect(seen).toEqual([0, 7]);
	});

	it("ignores clicks inside the indent gutter", () => {
		const line = new QuietZoneLine(() => "content", 3);
		const seen: number[] = [];
		line.onClick = col => seen.push(col);
		line.render(80);

		line.routeMouse(click(0), 0, 0);
		line.routeMouse(click(2), 0, 2);
		expect(seen).toEqual([]);
	});

	it("only left clicks route; wheel and non-left buttons are ignored", () => {
		const line = new QuietZoneLine(() => "content", 0);
		const seen: number[] = [];
		line.onClick = col => seen.push(col);
		line.render(80);

		line.routeMouse(click(5, { leftClick: false, button: 2 }), 0, 5);
		line.routeMouse(click(5, { leftClick: false, wheel: -1 as const }), 0, 5);
		expect(seen).toEqual([]);
		line.routeMouse(click(5), 0, 5);
		expect(seen).toEqual([5]);
	});

	it("uses the indent actually applied on the LAST render, not the configured one", () => {
		// Width 3 clamps the pad to width-1=2, not the configured 5. A click at
		// column 2 is then the first content column.
		const line = new QuietZoneLine(() => "x", 5);
		const seen: number[] = [];
		line.onClick = col => seen.push(col);
		line.render(3);

		line.routeMouse(click(2), 0, 2);
		expect(seen).toEqual([0]);
	});
});
