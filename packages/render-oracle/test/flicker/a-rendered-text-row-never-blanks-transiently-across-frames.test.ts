/**
 * A row carrying persistent text never blanks for one frame and returns unchanged.
 *
 * WHY THIS SUITE EXISTS:
 * A row that empties for a single frame and comes back with the same bytes is seen as a strobe
 * across the screen, and it is invisible to any check that only compares the first and last
 * frame. Overlays are where it happens: opening one recomposites the whole viewport, and closing
 * one restores it, so a background row can lose its text on the way through.
 *
 * WHAT THIS SUITE PROVES:
 * 1. A windowed overlay leaves every row it does not paint byte-identical while it is open. The
 *    rows it does paint are identified by the overlay's own marker, not by an index written into
 *    the test, so moving or resizing the dialog cannot quietly shrink what is checked.
 * 2. Closing an overlay restores every background row to the exact bytes it had before, for both
 *    overlay kinds, so nothing is left blank behind it.
 *
 * WHAT IT DOES NOT CATCH:
 * A fullscreen overlay blanks the background while it is open, which is what fullscreen means —
 * it borrows the alternate buffer and owns every row. Only its restore is checked here. Frames
 * are compared as the terminal ends them, so a blank written and overwritten inside one frame is
 * not visible to this suite; the byte-level checks in the identical-frame suites cover that.
 */

import { describe, expect, it } from "bun:test";
import { StressRenderScheduler, VirtualTerminal } from "@veyyon/render-oracle";
import { type Component, TUI } from "@veyyon/tui/tui";

class StaticContentComponent implements Component {
	constructor(private readonly lines: readonly string[]) {}

	render(_width: number): readonly string[] {
		return this.lines;
	}
}

const DIALOG_MARKER = "Confirm Action";

const dialogRows = [
	"┌──────────────────────────────┐",
	`│ ${DIALOG_MARKER}: Save?      │`,
	"│ [Yes]                 [No]   │",
	"└──────────────────────────────┘",
];

const transcriptRows = [
	"Row 0: Top persistent navigation header",
	"Row 1: Project workspace loaded successfully",
	"Row 2: Active file: packages/tui/src/tui.ts",
	"Row 3: Line 42: const frame = composeFrame()",
	"Row 4: Line 43: render(width)",
	"Row 5: Line 44: commitToHistory()",
	"Row 6: Compilation status: 0 errors",
	"Row 7: Ready for user input",
	"Row 8: [Mode: Normal]  [Git: main]",
	"Row 9: Status: Idle",
];

/** Drive one overlay through open and close, snapshotting the viewport at each step. */
async function overlayLifecycle(fullscreen: boolean) {
	const term = new VirtualTerminal(60, 10);
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	tui.addChild(new StaticContentComponent(transcriptRows));

	tui.start();
	await scheduler.drain(term);
	const before = term.getViewport().map(row => row.trimEnd());

	const handle = tui.showOverlay(new StaticContentComponent(dialogRows), {
		width: 32,
		maxHeight: 4,
		anchor: "center",
		fullscreen,
	});
	await scheduler.drain(term);
	const during = term.getViewport().map(row => row.trimEnd());

	handle.hide();
	await scheduler.drain(term);
	const after = term.getViewport().map(row => row.trimEnd());

	return { before, during, after };
}

describe("a rendered text row never blanks transiently across frames", () => {
	it("keeps every row a windowed overlay does not paint byte-identical while it is open", async () => {
		const { before, during } = await overlayLifecycle(false);

		// The overlay's own rows are the ones carrying its marker or its border, so the checked
		// set follows wherever the dialog lands instead of a hardcoded row range.
		const untouched = during
			.map((row, index) => ({ row, index }))
			.filter(
				entry =>
					!entry.row.includes(DIALOG_MARKER) &&
					!entry.row.includes("│") &&
					!entry.row.includes("┌") &&
					!entry.row.includes("└"),
			);

		expect(untouched.length).toBeGreaterThan(0);
		expect(untouched.length).toBeLessThan(during.length);
		for (const { row, index } of untouched) {
			expect(row).toBe(before[index]);
		}
	});

	it("restores every background row when a windowed overlay closes", async () => {
		const { before, after } = await overlayLifecycle(false);
		expect(after).toEqual(before);
	});

	it("restores every background row when a fullscreen overlay closes", async () => {
		const { before, during, after } = await overlayLifecycle(true);

		// Fullscreen owns the screen while open — that is the contract, and it is stated here so
		// the restore below is read as the whole claim rather than half of a missing one.
		expect(during.some(row => row.includes(DIALOG_MARKER))).toBe(true);
		expect(after).toEqual(before);
	});
});
