/**
 * A row that carries persistent text must never blank (become empty/whitespace) for an intermediate frame and then return with identical text.
 *
 * WHY THIS SUITE EXISTS:
 * When displaying modals, popups, overlay dialogues, or processing frame transitions,
 * rows of the underlying transcript/interface must remain stable. Blanking rows for a single
 * frame creates visible full-screen flashing / black blink as the eye perceives the 1-frame gap.
 *
 * ROOT CAUSE IN packages/tui/src/tui.ts:
 * 1. Line 3764: When an overlay opens with `wantsAltScreen() = true` (e.g. fullscreen: true / dialogs),
 *    the engine enters the alternate buffer and executes `#renderAltFrame(width, height)`.
 * 2. Line 5035: In `#renderAltFrame`, the window buffer is initialized as empty strings:
 *    `let window = new Array<string>(height).fill("");`
 *    Only the overlay's explicit bounds are composited; all background rows outside the overlay
 *    are painted as completely BLANK lines (`""`).
 * 3. Line 3790: When the overlay closes, `\x1b[?1049l` exits the alt screen back to the normal screen,
 *    restoring the original transcript text on the next frame.
 * 4. Across the 3-frame sequence (Frame 0: text, Frame 1: overlay active, Frame 2: overlay closed):
 *    Background rows are painted with text, blank out completely on Frame 1, and reappear with identical
 *    text on Frame 2 — creating a 1-frame strobe flash across all non-modal screen rows.
 *
 * WHAT THIS SUITE CLOSES:
 * - 1-frame blanking / strobe of background transcript rows during modal overlay lifecycle.
 * - Transient disappearing text during alternate-screen transitions.
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

describe("a rendered text row never blanks transiently across frames", () => {
	it("never blanks background transcript rows for a single frame when an overlay opens and closes", async () => {
		const term = new VirtualTerminal(60, 10);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });

		const transcriptLines = [
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
		const transcript = new StaticContentComponent(transcriptLines);
		tui.addChild(transcript);

		tui.start();
		await scheduler.drain(term);

		// Frame 0: Stable base view
		const frame0Rows = term.getViewport().map(r => r.trimEnd());
		expect(frame0Rows[0]).toContain("Row 0: Top persistent navigation header");
		expect(frame0Rows[8]).toContain("Row 8: [Mode: Normal]");

		// Frame 1: Open a centered modal dialog (occupying rows 3..6, leaving rows 0..2 and 7..9 as background)
		const dialog = new StaticContentComponent([
			"┌──────────────────────────────┐",
			"│ Confirm Action: Save Changes?│",
			"│ [Yes]                 [No]   │",
			"└──────────────────────────────┘",
		]);
		const handle = tui.showOverlay(dialog, {
			width: 32,
			maxHeight: 4,
			anchor: "center",
			fullscreen: true,
		});
		await scheduler.drain(term);

		// Frame 1 snapshot
		const frame1Rows = term.getViewport().map(r => r.trimEnd());

		// Frame 2: Close the modal dialog
		handle.hide();
		await scheduler.drain(term);

		// Frame 2 snapshot
		const frame2Rows = term.getViewport().map(r => r.trimEnd());
		expect(frame2Rows[0]).toContain("Row 0: Top persistent navigation header");
		expect(frame2Rows[8]).toContain("Row 8: [Mode: Normal]");

		// CONTRACT DEFENSE:
		// For every background row outside the dialog (e.g. Row 0, Row 1, Row 8, Row 9):
		// The row carried text on Frame 0 and carries identical text on Frame 2.
		// It must NOT blank (become empty string `""`) on Frame 1.
		//
		// ROOT CAUSE FAILURE ON CURRENT MAIN:
		// When fullscreen: true is set, line 3764 switches to alt buffer and line 5035 in `#renderAltFrame`
		// fills all un-composited rows with `""`. As a result, frame1Rows[0], frame1Rows[1], frame1Rows[8]
		// are completely empty `""` on Frame 1, flashing black for 1 frame before returning on Frame 2.
		const backgroundRowIndices = [0, 1, 8, 9];
		for (const rowIndex of backgroundRowIndices) {
			const textBefore = frame0Rows[rowIndex];
			const textDuring = frame1Rows[rowIndex];
			const textAfter = frame2Rows[rowIndex];

			// Row must carry the background text continuously without transiently blanking
			expect(textDuring).not.toBe("");
			expect(textDuring).toEqual(textBefore);
			expect(textAfter).toEqual(textBefore);
		}
	});
});
