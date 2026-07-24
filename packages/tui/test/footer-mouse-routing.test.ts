/**
 * Pinned-footer click routing (GMI-2b).
 *
 * Why this suite exists: while scroll isolation's wheel tracking is on, the
 * TUI consumes every SGR mouse report itself — clicks in the pinned footer
 * were either swallowed or only snapped the view back to the live tail, so no
 * footer chrome (like the status footline's goal readout) could own a click
 * target. The TUI now resolves a footer click to the root child under it via
 * the frame-segment ledger and forwards frame-local coordinates to components
 * implementing MouseRoutable. These tests lock the row/col math (screen row →
 * frame row → child-local line), the opt-in contract (non-routable children
 * keep ignoring clicks), and that transcript clicks are never routed.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { Component } from "@veyyon/tui";
import type { MouseRoutable, SgrMouseEvent } from "@veyyon/tui/mouse";
import { TUI } from "@veyyon/tui/tui";
import { VirtualTerminal } from "./virtual-terminal";

/** A fixed-height block of transcript filler. */
class Filler implements Component {
	constructor(private readonly rows: number) {}
	render(): string[] {
		return Array.from({ length: this.rows }, (_, i) => `filler-${i}`);
	}
}

/** A two-row footer child that records routed mouse events. */
class RoutableFooter implements Component, MouseRoutable {
	calls: Array<{ line: number; col: number; leftClick: boolean }> = [];
	render(): string[] {
		return ["footer-a", "footer-b"];
	}
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		this.calls.push({ line, col, leftClick: event.leftClick });
	}
}

/** A footer child with no mouse support at all. */
class PlainFooter implements Component {
	render(): string[] {
		return ["plain-footer"];
	}
}

/** SGR left-button press at 0-based (row, col). */
function leftClickAt(row: number, col: number): string {
	return `\x1b[<0;${col + 1};${row + 1}M`;
}

const ROWS = 10;
const COLS = 40;

async function mountFooterTui(footerChildren: Component[]): Promise<{ tui: TUI; term: VirtualTerminal }> {
	const term = new VirtualTerminal(COLS, ROWS, 1000);
	const tui = new TUI(term, true);
	// Filler taller than the terminal makes the frame scrollable, which is the
	// precondition for wheel tracking (the only mode that reports clicks).
	tui.addChild(new Filler(ROWS + 5));
	for (const child of footerChildren) tui.addChild(child);
	tui.setPinnedFooterChildCount(footerChildren.length);
	tui.setScrollIsolation(true);
	tui.start();
	await term.waitForRender();
	return { tui, term };
}

describe("pinned-footer mouse routing", () => {
	let stop: (() => void) | undefined;
	afterEach(() => {
		stop?.();
		stop = undefined;
	});

	it("routes a footer click to the MouseRoutable child with child-local line and col", async () => {
		const footer = new RoutableFooter();
		const { tui, term } = await mountFooterTui([footer]);
		stop = () => tui.stop();

		// Footer is the last 2 frame rows, pinned to the last 2 screen rows.
		// Clicking the SECOND footer row must arrive as line 1 of the child.
		term.sendInput(leftClickAt(ROWS - 1, 7));
		expect(footer.calls).toEqual([{ line: 1, col: 7, leftClick: true }]);

		term.sendInput(leftClickAt(ROWS - 2, 3));
		expect(footer.calls[1]).toEqual({ line: 0, col: 3, leftClick: true });
	});

	it("routes to the correct child when the footer has several children", async () => {
		const plain = new PlainFooter();
		const routable = new RoutableFooter();
		const { tui, term } = await mountFooterTui([plain, routable]);
		stop = () => tui.stop();

		// Footer rows (bottom-up): footer-b, footer-a, plain-footer. A click on
		// the plain child routes nowhere and must not throw; a click on the
		// routable child's first row arrives as line 0.
		term.sendInput(leftClickAt(ROWS - 3, 0));
		expect(routable.calls).toEqual([]);

		term.sendInput(leftClickAt(ROWS - 2, 12));
		expect(routable.calls).toEqual([{ line: 0, col: 12, leftClick: true }]);
	});

	it("never routes clicks landing above the pinned footer", async () => {
		const footer = new RoutableFooter();
		const { tui, term } = await mountFooterTui([footer]);
		stop = () => tui.stop();

		term.sendInput(leftClickAt(0, 0));
		term.sendInput(leftClickAt(ROWS - 3, 5));
		expect(footer.calls).toEqual([]);
	});
});
