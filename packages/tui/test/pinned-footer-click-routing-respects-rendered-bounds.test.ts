/**
 * WHY THIS SUITE EXISTS:
 *
 * Scroll isolation captures SGR mouse reports while wheel tracking is active so
 * the wheel can scroll transcript history while the pinned footer remains live.
 * An audit revealed two defects in the mouse hit-testing boundary:
 *
 * 1. Short frame: When the rendered frame is shorter than the terminal, the
 *    footer is drawn immediately following the content (anchored at windowTop 0),
 *    not at the terminal bottom. Computing `footerTop = terminal.rows - #pinnedFooterRows`
 *    placed the hit-test boundary at the bottom of the screen, causing clicks
 *    on the visible footer to be treated as transcript selections and clicks on
 *    blank space below the frame to be dispatched to the footer child.
 * 2. Short terminal / tall footer: When `#pinnedFooterRows >= terminal.rows`,
 *    `terminal.rows - #pinnedFooterRows` became zero or negative, treating every
 *    screen report as a footer click and computing out-of-range or negative
 *    frame-local coordinates for the child.
 *
 * What this closes:
 * - Derives the footer hit-test boundary (`footerTop`, `footerBottom`, `contentBottom`,
 *   `footerRowOffset`) directly from the renderer's windowing state (`#windowTopRow`
 *   and composed frame length in live tail mode; `regionRows` in virtual scroll mode).
 * - Clamps frame-local coordinates within `[0, segment.rowCount - 1]` so child
 *   components never receive negative or out-of-range lines.
 * - Ensures drag selection detection and footer click routing share the identical
 *   boundary definition in all terminal geometries and scroll modes.
 *
 * What this does not catch:
 * - Terminal emulator SGR protocol quirks where mouse reports are delivered with
 *   scrambled button bits or negative coordinates from external multiplexers.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { VirtualTerminal } from "@veyyon/render-oracle";
import type { Component } from "@veyyon/tui";
import type { MouseRoutable, SgrMouseEvent } from "@veyyon/tui/mouse";
import { TUI } from "@veyyon/tui/tui";

/** SGR left-button press report at 0-based (row, col). */
function pressAt(row: number, col = 0): string {
	return `\x1b[<0;${col + 1};${row + 1}M`;
}

/** SGR left-button release report at 0-based (row, col). */
function releaseAt(row: number, col = 0): string {
	return `\x1b[<0;${col + 1};${row + 1}m`;
}

const WHEEL_UP = "\x1b[<64;5;5M";

/** Fixed-height transcript filler component. */
class Filler implements Component {
	constructor(private readonly rows: number) {}
	render(): string[] {
		return Array.from({ length: this.rows }, (_, i) => `filler-line-${i}`);
	}
}

/** Routable footer component that records received mouse events. */
class RoutableFooter implements Component, MouseRoutable {
	calls: Array<{ line: number; col: number; leftClick: boolean }> = [];
	constructor(
		private readonly rows: number,
		private readonly label = "footer",
	) {}

	render(): string[] {
		return Array.from({ length: this.rows }, (_, i) => `${this.label}-${i}`);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		this.calls.push({ line, col, leftClick: event.leftClick });
	}

	wantsPointer(): boolean {
		return true;
	}

	clear(): void {
		this.calls.length = 0;
	}
}

interface Harness {
	tui: TUI;
	term: VirtualTerminal;
	selectionAttempts: number;
}

async function createHarness(cols: number, rows: number, setup: (tui: TUI) => void): Promise<Harness> {
	const term = new VirtualTerminal(cols, rows, 1000);
	const tui = new TUI(term, true);
	setup(tui);
	tui.setScrollIsolation(true);
	const harness: Harness = { tui, term, selectionAttempts: 0 };
	tui.onSelectionAttempt = () => {
		harness.selectionAttempts += 1;
	};
	tui.start();
	await term.waitForRender();
	return harness;
}

describe("pinned footer click routing respects rendered bounds", () => {
	let cleanup: (() => void) | undefined;
	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	it("handles a frame shorter than the terminal: routes footer clicks and ignores empty space", async () => {
		// Terminal is 10 rows high. Content has 3 filler rows + 2 footer rows = 5 rows.
		// Rendered frame:
		// row 0: filler-line-0
		// row 1: filler-line-1
		// row 2: filler-line-2
		// row 3: footer-0 (first footer row)
		// row 4: footer-1 (second footer row)
		// rows 5-9: blank space below content
		const footer = new RoutableFooter(2);
		const harness = await createHarness(40, 10, instance => {
			instance.addChild(new Filler(3));
			instance.addChild(footer);
			instance.setPinnedFooterChildCount(1);
		});
		cleanup = () => harness.tui.stop();

		// 1. Click on transcript (row 1, col 4) -> should NOT route to footer
		harness.term.sendInput(pressAt(1, 4));
		harness.term.sendInput(releaseAt(1, 10)); // drag across -> selection attempt
		expect(harness.selectionAttempts).toBe(1);
		expect(footer.calls).toEqual([]);

		// 2. Click exactly on the last content row (row 2, col 3) -> transcript region
		harness.term.sendInput(pressAt(2, 3));
		harness.term.sendInput(releaseAt(2, 8)); // drag across -> selection attempt
		expect(harness.selectionAttempts).toBe(2);
		expect(footer.calls).toEqual([]);
		// 3. Click exactly on the first footer row (row 3, col 5) -> routes to footer line 0
		harness.term.sendInput(pressAt(3, 5));
		harness.term.sendInput(releaseAt(3, 5));
		expect(footer.calls).toEqual([{ line: 0, col: 5, leftClick: true }]);
		footer.clear();

		// 4. Click on the second footer row (row 4, col 2) -> routes to footer line 1
		harness.term.sendInput(pressAt(4, 2));
		harness.term.sendInput(releaseAt(4, 2));
		expect(footer.calls).toEqual([{ line: 1, col: 2, leftClick: true }]);
		footer.clear();

		// 5. Click on empty space below content (row 5) -> neither footer nor drag selection
		harness.term.sendInput(pressAt(5, 0));
		harness.term.sendInput(releaseAt(5, 10));
		expect(footer.calls).toEqual([]);

		// 6. Click on empty space near terminal bottom (row 8 = HEIGHT - 2) -> must not route
		harness.term.sendInput(pressAt(8, 0));
		harness.term.sendInput(releaseAt(8, 0));
		expect(footer.calls).toEqual([]);
	});

	it("handles a footer taller than the terminal without out-of-bounds coordinates", async () => {
		// Terminal is 4 rows high. Frame has 2 filler rows + 6 footer rows = 8 rows.
		// windowTop = 8 - 4 = 4.
		// Visible screen rows 0..3 display frame rows 4..7 (footer rows 2..5 of the 6-row footer).
		const footer = new RoutableFooter(6);
		const { tui, term } = await createHarness(40, 4, instance => {
			instance.addChild(new Filler(2));
			instance.addChild(footer);
			instance.setPinnedFooterChildCount(1);
		});
		cleanup = () => tui.stop();

		// Click screen row 0 -> should map to footer line 2
		term.sendInput(pressAt(0, 7));
		expect(footer.calls).toEqual([{ line: 2, col: 7, leftClick: true }]);
		footer.clear();

		// Click screen row 1 -> should map to footer line 3
		term.sendInput(pressAt(1, 3));
		expect(footer.calls).toEqual([{ line: 3, col: 3, leftClick: true }]);
		footer.clear();

		// Click screen row 3 -> should map to footer line 5
		term.sendInput(pressAt(3, 11));
		expect(footer.calls).toEqual([{ line: 5, col: 11, leftClick: true }]);
		footer.clear();
	});

	it("handles a terminal exactly one row tall with a footer", async () => {
		// Terminal is 1 row high. Frame has 3 filler rows + 2 footer rows = 5 rows.
		// windowTop = 5 - 1 = 4.
		// Screen row 0 displays frame row 4 (footer line 1).
		const footer = new RoutableFooter(2);
		const { tui, term } = await createHarness(40, 1, instance => {
			instance.addChild(new Filler(3));
			instance.addChild(footer);
			instance.setPinnedFooterChildCount(1);
		});
		cleanup = () => tui.stop();

		// Click screen row 0 -> routes to footer line 1
		term.sendInput(pressAt(0, 4));
		expect(footer.calls).toEqual([{ line: 1, col: 4, leftClick: true }]);
	});

	it("handles a terminal exactly one row tall with no footer", async () => {
		// Terminal is 1 row high. Frame has 3 filler rows, 0 footer rows.
		// Screen row 0 displays transcript.
		const harness = await createHarness(40, 1, instance => {
			instance.addChild(new Filler(3));
			instance.setPinnedFooterChildCount(0);
		});
		cleanup = () => harness.tui.stop();

		// Click row 0, release row 0 (different col) -> triggers selection attempt
		harness.term.sendInput(pressAt(0, 2));
		harness.term.sendInput(releaseAt(0, 8));
		expect(harness.selectionAttempts).toBe(1);
	});

	it("routes correctly across multiple footer children", async () => {
		// Terminal is 10 rows high. Frame has 2 filler rows + footerA (2 rows) + footerB (3 rows) = 7 rows.
		// Frame rows:
		// 0..1: filler (rows 0, 1)
		// 2..3: footerA (rows 2, 3) -> lines 0, 1
		// 4..6: footerB (rows 4, 5, 6) -> lines 0, 1, 2
		// 7..9: empty
		const footerA = new RoutableFooter(2, "footerA");
		const footerB = new RoutableFooter(3, "footerB");
		const { tui, term } = await createHarness(40, 10, instance => {
			instance.addChild(new Filler(2));
			instance.addChild(footerA);
			instance.addChild(footerB);
			instance.setPinnedFooterChildCount(2);
		});
		cleanup = () => tui.stop();

		// Click row 2 -> footerA line 0
		term.sendInput(pressAt(2, 5));
		expect(footerA.calls).toEqual([{ line: 0, col: 5, leftClick: true }]);
		expect(footerB.calls).toEqual([]);
		footerA.clear();

		// Click row 3 -> footerA line 1
		term.sendInput(pressAt(3, 1));
		expect(footerA.calls).toEqual([{ line: 1, col: 1, leftClick: true }]);
		expect(footerB.calls).toEqual([]);
		footerA.clear();

		// Click row 4 -> footerB line 0
		term.sendInput(pressAt(4, 8));
		expect(footerA.calls).toEqual([]);
		expect(footerB.calls).toEqual([{ line: 0, col: 8, leftClick: true }]);
		footerB.clear();

		// Click row 6 -> footerB line 2
		term.sendInput(pressAt(6, 9));
		expect(footerA.calls).toEqual([]);
		expect(footerB.calls).toEqual([{ line: 2, col: 9, leftClick: true }]);
		footerB.clear();

		// Click row 7 (empty space) -> no calls
		term.sendInput(pressAt(7, 0));
		expect(footerA.calls).toEqual([]);
		expect(footerB.calls).toEqual([]);
	});

	it("routes footer clicks and resumes live tail during virtual scroll", async () => {
		// Terminal is 10 rows high. Frame has 20 filler rows + 2 footer rows = 22 rows.
		// Scrolled back with wheel-up.
		const footer = new RoutableFooter(2);
		const { tui, term } = await createHarness(40, 10, instance => {
			instance.addChild(new Filler(20));
			instance.addChild(footer);
			instance.setPinnedFooterChildCount(1);
		});
		cleanup = () => tui.stop();

		// Scroll up into history
		term.sendInput(WHEEL_UP);
		await term.waitForRender();
		expect(tui.virtualScrollActive).toBe(true);

		// In virtual scroll on a 10-row terminal with 2 footer rows:
		// rows 0..7 are frozen transcript
		// rows 8..9 are pinned live footer
		// Click on transcript (row 3) -> should not resume live tail, no footer route
		term.sendInput(pressAt(3, 4));
		expect(footer.calls).toEqual([]);
		expect(tui.virtualScrollActive).toBe(true);

		// Click on pinned footer (row 8) -> routes to footer line 0 and resumes live tail
		term.sendInput(pressAt(8, 6));
		expect(footer.calls).toEqual([{ line: 0, col: 6, leftClick: true }]);
		expect(tui.virtualScrollActive).toBe(false);
	});
});
