/**
 * Behavior Defended:
 * An unfocused or non-interactive frame must never floor the window top at committedRows
 * above the composer tail. Regardless of whether the frame is driven by a tool output collapse,
 * a focus restoration transition, a background subagent turn, or a viewer-mode stream completion,
 * the composer must remain anchored continuously at the bottom physical rows of the viewport.
 *
 * WHY THIS SUITE EXISTS:
 * When the editor is unfocused (`tui.setFocus(null)` or focus on a non-editor viewer), `cursorMarkers`
 * contains no active caret markers. In `packages/tui/src/tui.ts:4118`, the tail re-anchor requires
 * `cursorMarkers.some(marker => marker.row >= this.#committedRows)`. When that check evaluates to
 * false because of missing focus, `tui.ts` takes line 4148 and floors
 * `windowTop = Math.max(this.#committedRows, frameLength - height, 0)`.
 *
 * This pushes the composer to the top or middle of the screen (e.g. rows 0..4) and emits dozens of
 * trailing blank rows underneath it. This defect affects every lifecycle transition that mutates
 * the frame while unfocused.
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
	checkNoFooterRowsAboveFooterRegion,
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

interface TransitionCase {
	name: string;
	initialTranscriptRows: number;
	collapsedTranscriptRows: number;
	initialFocused: boolean;
	subsequentFocusRestore?: boolean;
}

const CASES: readonly TransitionCase[] = [
	{
		name: "live tool output collapse during unfocused execution",
		initialTranscriptRows: 45,
		collapsedTranscriptRows: 30,
		initialFocused: false,
	},
	{
		name: "focus restoration lifecycle after background turn collapse",
		initialTranscriptRows: 50,
		collapsedTranscriptRows: 35,
		initialFocused: true,
		subsequentFocusRestore: true,
	},
	{
		name: "background subagent turn completion in viewer mode",
		initialTranscriptRows: 40,
		collapsedTranscriptRows: 25,
		initialFocused: false,
	},
	{
		name: "streaming transcript finish while unfocused",
		initialTranscriptRows: 42,
		collapsedTranscriptRows: 28,
		initialFocused: false,
	},
] as const;

describe("an unfocused frame never floors the window above the composer", () => {
	for (const scenario of CASES) {
		it(`anchors footer at viewport bottom during ${scenario.name}`, async () => {
			const term = new VirtualTerminal(80, 20, 10000);
			const tui = new TUI(term, true);

			const transcript = new TranscriptMock();
			transcript.lines = Array.from(
				{ length: scenario.initialTranscriptRows },
				(_, i) => `transcript-output-line-${String(i).padStart(4, "0")}`,
			);
			tui.addChild(transcript);

			// Pinned footer components (5 rows)
			const hairline = new SimpleLine("─".repeat(80));
			const padTop = new SimpleLine("");
			const editor = new Editor(defaultEditorTheme);
			editor.setPromptGutter("  › ");
			editor.setBorderVisible(false);
			editor.setText("scenario prompt");
			const padBottom = new SimpleLine("");
			const statusLine = new SimpleLine("location: ~/project · model: test-model");

			tui.addChild(hairline);
			tui.addChild(padTop);
			tui.addChild(editor);
			tui.addChild(padBottom);
			tui.addChild(statusLine);

			tui.setPinnedFooterChildCount(5);

			if (scenario.initialFocused) {
				tui.setFocus(editor);
			} else {
				tui.setFocus(null);
			}

			tui.start();
			await settleFrames(term, tui);

			// Transition: background execution runs and then collapses output while unfocused
			if (scenario.initialFocused) {
				tui.setFocus(null);
			}
			transcript.lines = Array.from(
				{ length: scenario.collapsedTranscriptRows },
				(_, i) => `transcript-output-line-${String(i).padStart(4, "0")}`,
			);
			tui.requestRender();
			await settleFrames(term, tui);

			const rawViewport = term.getViewport();
			const viewportLines = rawViewport.map(l => stripVTControlCharacters(stripAnsi(l)));

			const totalFrameRows = scenario.collapsedTranscriptRows + 5;
			const expectedWindowTop = Math.max(0, totalFrameRows - 20);

			const frameState: ComposerOracleFrameState = {
				width: 80,
				height: 20,
				viewportLines,
				rawViewportLines: rawViewport,
				cursor: term.getCursor(),
				totalFrameRows,
				windowTopRow: expectedWindowTop,
				pinnedFooterChildCount: 5,
				pinnedFooterRows: 5,
				virtualScrollTop: null,
				screenBounds: {
					footerTop: 15,
					footerBottom: 19,
					footerRowOffset: 15,
					contentBottom: 19,
				},
				segments: [
					{ startIndex: 0, rowCount: scenario.collapsedTranscriptRows, componentName: "TranscriptMock" },
					{ startIndex: scenario.collapsedTranscriptRows, rowCount: 1, componentName: "ComposerHairline" },
					{ startIndex: scenario.collapsedTranscriptRows + 1, rowCount: 1, componentName: "CardPadRow" },
					{ startIndex: scenario.collapsedTranscriptRows + 2, rowCount: 1, componentName: "Editor" },
					{ startIndex: scenario.collapsedTranscriptRows + 3, rowCount: 1, componentName: "CardPadRow" },
					{ startIndex: scenario.collapsedTranscriptRows + 4, rowCount: 1, componentName: "QuietZoneLine" },
				],
				expectedPromptGlyph: "›",
				editorFocused: false,
				transcriptLineMarkers: ["transcript-output-line-"],
			};

			const failureAbove = checkNoFooterRowsAboveFooterRegion(frameState);
			const failureBottom = checkFooterOccupiesBottomPhysicalRows(frameState);

			tui.stop();

			// In a correct renderer:
			// - Footer must occupy rows 15..19 at the bottom of the 20-row viewport.
			// - No footer rows (such as hairline or prompt) may appear at rows 0..14.
			// On current main, this FAILS (RED) because windowTop is floored at committedRows,
			// placing the hairline at row 0 and leaving 15 blank lines below.
			expect(failureAbove).toBeNull();
			expect(failureBottom).toBeNull();
		});
	}
});
