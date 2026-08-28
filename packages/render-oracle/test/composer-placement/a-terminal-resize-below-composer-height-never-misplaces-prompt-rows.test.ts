/**
 * Behavior Defended:
 * When the terminal is resized so that the viewport height is less than or equal to the
 * pinned composer zone height (e.g., 5-row viewport with an 8-row footer chrome), the visible
 * footer must occupy all available physical rows (from row 0 to height - 1) and must not
 * misidentify rendered composer editor rows as transcript rows.
 *
 * WHY THIS SUITE EXISTS:
 * In narrow or vertically constrained split panes, the terminal height can drop below the
 * composer chrome's row count (hairline + pads + multiline editor + status + shortcuts).
 * In `tui.ts`, `#pinnedFooterScreenBounds()` calculates footer bounds using
 * `footerRows = Math.min(this.#pinnedFooterRows, height - 1)`. When `pinnedFooterRows >= height`,
 * this artificially forces `footerTop = height - (height - 1) = 1`, declaring row 0 to be the
 * transcript region even though all rows 0..height-1 on screen are actually painted by the footer!
 * This causes mouse click routing to dispatch clicks on the composer editor at row 0 to the
 * transcript, and defect oracles to detect prompt and hairline bleed above the reported footer zone.
 *
 * GUARANTEES TESTED:
 * - footerOccupiesBottomPhysicalRows (Oracle Guarantee 4)
 * - noFooterRowsAboveFooterRegion (Oracle Guarantee 5)
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
	type ComposerOracleFrameState,
	checkFooterOccupiesBottomPhysicalRows,
	settleFrames,
	VirtualTerminal,
} from "@veyyon/render-oracle";
import { type Component, Editor, TUI } from "@veyyon/tui";
import { defaultEditorTheme } from "@veyyon/tui/test-support";
import { stripAnsi } from "@veyyon/utils";

class TranscriptMock implements Component {
	lines: string[] = [];
	render(width: number): string[] {
		return this.lines.map(l => l.slice(0, width));
	}
}

class SimpleLine implements Component {
	constructor(public text: string) {}
	render(width: number): string[] {
		return [this.text.slice(0, width)];
	}
}

describe("composer placement under terminal height constraints", () => {
	it("correctly bounds footer zone across the entire viewport when height is smaller than footer", async () => {
		const term = new VirtualTerminal(80, 20, 10000);
		const tui = new TUI(term, true);

		const transcript = new TranscriptMock();
		transcript.lines = Array.from({ length: 10 }, (_, i) => `transcript-output-line-${String(i).padStart(4, "0")}`);
		tui.addChild(transcript);

		// Pinned footer with 8 rows:
		// row 0: hairline (1)
		// row 1: padTop (1)
		// row 2..4: 3-line editor (3)
		// row 5: padBottom (1)
		// row 6: statusLine (1)
		// row 7: shortcuts (1)
		const hairline = new SimpleLine("─".repeat(80));
		const padTop = new SimpleLine("");
		const editor = new Editor(defaultEditorTheme);
		editor.setPromptGutter("  › ");
		editor.setBorderVisible(false);
		editor.setText("line 1\nline 2\nline 3");
		const padBottom = new SimpleLine("");
		const statusLine = new SimpleLine("location: ~/project · model: test-model");
		const shortcuts = new SimpleLine("/ menu · ^c exit");

		tui.addChild(hairline);
		tui.addChild(padTop);
		tui.addChild(editor);
		tui.addChild(padBottom);
		tui.addChild(statusLine);
		tui.addChild(shortcuts);

		tui.setPinnedFooterChildCount(6);
		tui.setFocus(editor);

		tui.start();
		await settleFrames(term, tui);

		// 2. Transition: Shrink terminal height to 5 rows (smaller than the 8-row footer)
		term.resize(80, 5);
		await settleFrames(term, tui);

		const rawViewport = term.getViewport();
		const viewportLines = rawViewport.map(l => stripVTControlCharacters(stripAnsi(l)));

		// The bounds come from the TUI itself, not from a literal written here: this check reads
		// only `screenBounds`, so a hand-written value would compare a constant against a constant
		// and hold whatever the renderer did. `pinnedFooterScreenBounds` is the same value the
		// click router acts on.
		const screenBounds = tui.pinnedFooterScreenBounds;
		const totalFrameRows = tui.composedFrameRows;
		const frameState: ComposerOracleFrameState = {
			width: 80,
			height: 5,
			viewportLines,
			rawViewportLines: rawViewport,
			cursor: term.getCursor(),
			totalFrameRows,
			windowTopRow: Math.max(0, totalFrameRows - 5),
			// Inputs this test constructs: six footer children totalling eight rows.
			pinnedFooterChildCount: 6,
			pinnedFooterRows: 8,
			virtualScrollTop: null,
			screenBounds,
			segments: [
				{ startIndex: 0, rowCount: 10, componentName: "TranscriptMock" },
				{ startIndex: 10, rowCount: 1, componentName: "ComposerHairline" },
				{ startIndex: 11, rowCount: 1, componentName: "CardPadRow" },
				{ startIndex: 12, rowCount: 3, componentName: "Editor" },
				{ startIndex: 15, rowCount: 1, componentName: "CardPadRow" },
				{ startIndex: 16, rowCount: 1, componentName: "QuietZoneLine" },
				{ startIndex: 17, rowCount: 1, componentName: "ComposerShortcuts" },
			],
			expectedPromptGlyph: "›",
			editorFocused: true,
			transcriptLineMarkers: ["transcript-output-line-"],
		};

		const failureBottom = checkFooterOccupiesBottomPhysicalRows(frameState);

		tui.stop();

		// On a correct renderer, when pinned footer rows exceed viewport height,
		// the visible footer top must be row 0 (expectedVisibleFooterTop: 0).
		// On current main, this FAILS (RED) because screenBounds.footerTop is 1 instead of 0.
		expect(failureBottom).toBeNull();
	});
});
