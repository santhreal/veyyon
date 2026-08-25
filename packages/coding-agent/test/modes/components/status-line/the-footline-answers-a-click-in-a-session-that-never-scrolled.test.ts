/**
 * WHY THIS SUITE EXISTS. The footline owns click targets -- the context gauge opens the
 * breakdown, the secrets chip lists credentials, the goal readout opens goal detail, and a
 * click on the path widens it -- and every one of them was inert in a session that had not
 * scrolled yet.
 *
 * Button reports only arrive while the engine holds the mouse, and it takes the grab when
 * the composed frame overflows the viewport OR a pinned-footer child asks for it
 * (`TUI.#syncWheelTracking`). A fresh session satisfies neither: nothing has scrolled, and
 * the only footer child that ever asked was the shortcuts bar, which renders no chips at
 * rest. So the whole footline answered clicks later in a session and not at the start of
 * one, which reads as a surface that works intermittently rather than one that is gated.
 *
 * THE CLASS THIS CLOSES: a footer component that owns a click target but never declares
 * the grab. The suite drives the real `TUI` over a real `QuietZoneLine` with a frame
 * SHORTER than the terminal, which is the case the existing routing suite
 * (`packages/tui/test/footer-mouse-routing.test.ts`) cannot see -- it fills the frame past
 * the viewport precisely to get tracking armed.
 *
 * WHAT IT DOES NOT CATCH: which segment a column lands on. That is
 * `StatusLineComponent.quietSegmentAt`, pinned in quiet-bounds.test.ts, and a click that
 * reaches the line with the wrong column is a different defect from one that never
 * arrives.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { QuietZoneLine } from "@veyyon/coding-agent/modes/components/composer-chrome";
import type { Component } from "@veyyon/tui";
import { TUI } from "@veyyon/tui/tui";
import { VirtualTerminal } from "../../../../../tui/test/virtual-terminal";

const COLS = 120;
const ROWS = 24;
const INDENT = 2;

/** A block of transcript short enough to leave the frame inside the viewport. */
class ShortTranscript implements Component {
	render(): string[] {
		return ["one line of history"];
	}
}

/** SGR left-button press at 0-based (row, col), the bytes a terminal sends. */
function leftPressAt(row: number, col: number): string {
	return `\x1b[<0;${col + 1};${row + 1}M`;
}

async function mount(isolation: boolean): Promise<{
	tui: TUI;
	term: VirtualTerminal;
	clicks: number[];
	footerRow: number;
}> {
	const term = new VirtualTerminal(COLS, ROWS, 1000);
	const tui = new TUI(term, true);
	const clicks: number[] = [];
	const footline = new QuietZoneLine(width => `~/platform-services/ingest-pipeline/nor…`.slice(0, width), INDENT);
	footline.onClick = col => clicks.push(col);

	tui.addChild(new ShortTranscript());
	tui.addChild(footline);
	tui.setPinnedFooterChildCount(1);
	tui.setScrollIsolation(isolation);
	tui.start();
	await term.waitForRender();

	// The pinned footer is the last frame row (row 1), rendered directly below the
	// short transcript.
	return { tui, term, clicks, footerRow: 1 };
}

describe("the footline answers a click in a session that never scrolled", () => {
	let stop: (() => void) | undefined;
	afterEach(() => {
		stop?.();
		stop = undefined;
	});

	it("routes the click to the line, with the indent already subtracted", async () => {
		const { tui, term, clicks, footerRow } = await mount(true);
		stop = () => tui.stop();

		term.sendInput(leftPressAt(footerRow, INDENT + 9));
		await term.waitForRender();

		// The column the handler receives is line-local: `quietSegmentAt` is indexed from
		// the first character the provider rendered, not from the terminal's left edge.
		expect(clicks).toEqual([9]);
	});

	it("hands the mouse back when scroll isolation is off, so the click never arrives", async () => {
		// NOT A BUG, AND THE REASON THIS SUITE CANNOT ASSERT THE CLICK UNCONDITIONALLY.
		// Holding the mouse costs the operator drag-select, so the grab is opt-in
		// (`tui.scrollIsolation`, off by default). With it off the terminal keeps every
		// button report and no footline target can fire -- the gauge included.
		const { tui, term, clicks, footerRow } = await mount(false);
		stop = () => tui.stop();

		term.sendInput(leftPressAt(footerRow, INDENT + 9));
		await term.waitForRender();

		expect(clicks).toEqual([]);
	});

	it("declares the grab only for a line that can act on a click", async () => {
		// A footline with no handler is printed chrome, and printed chrome has no business
		// costing the operator drag-select. This is the one place the opt-in is decided, so
		// a line that stops handling clicks must stop holding the mouse in the same step.
		const printOnly = new QuietZoneLine(() => "nothing to click here", INDENT);
		expect(printOnly.wantsPointer()).toBe(false);

		printOnly.onClick = () => {};
		expect(printOnly.wantsPointer()).toBe(true);
	});
});
