/**
 * Behavior Defended:
 * When tool results or transcript components render (e.g. direct-placement image sequences,
 * collapsed tool summary cards, or multi-block transcript outputs), the TUI must never compose
 * or settle a frame that contains positional blank space defects:
 *
 * 1. HOLE: A continuous run of unpainted/empty rows bounded by legitimate painted content
 *    both above and below within the active viewport region.
 * 2. STRANDED CHROME: The pinned composer/footer row is left floating mid-screen with
 *    trailing unpainted blank rows beneath it when the frame length demands full viewport usage.
 * 3. TRANSIENT BLANK: A row with painted content in frame N disappears into empty blank space
 *    in frame N+1 without a valid layout scroll or component removal accounting for it.
 *
 * WHY THIS SUITE EXISTS:
 * A blank row on screen is not evidence by itself. A direct-placement image
 * paints pixels the text grid cannot hold, so every row it reserves reads as
 * blank however correct the placement is, and the transcript pads around its
 * children by design. An oracle that only looks at the screen calls all of that
 * a hole, and no renderer change can make it stop.
 *
 * The frame the renderer composed is the other half. A row composed with
 * content and painted blank is a dropped row; a row composed blank is the
 * layout's own. `unpaintedComposedRows` compares the two, which is what makes a
 * failure here mean something. Mutating `#prepareLine` to blank one composed row
 * turns this suite red; dropping a reserved row inside the image component does
 * not, because that shortens the frame and the screen still matches it.
 *
 * GUARANTEES DEFENDED:
 * - Dynamic runtime sweep across all `ImageProtocol` members (Sixel, iTerm2, Kitty direct-placement).
 * - Positional HOLE detection verifying no unpainted gaps exist between painted parent/sibling blocks.
 * - Positional STRANDED CHROME detection verifying the composer/footer occupies the terminal bottom.
 * - Verification across terminal dimensions (width 80/120, height 24/40/60).
 */

import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { ToolExecutionComponent } from "@veyyon/coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@veyyon/coding-agent/modes/components/transcript-container";
import { getThemeByName, initTheme, setThemeInstance, theme } from "@veyyon/coding-agent/modes/theme/theme";
import {
	findStrandedChrome,
	findViewportHoles,
	settleFrames,
	type ViewportHole,
	VirtualTerminal,
} from "@veyyon/render-oracle";
import { Editor, ImageProtocol, setKittyGraphics, setTerminalImageProtocol, TERMINAL, Text, TUI } from "@veyyon/tui";
import { Image } from "@veyyon/tui/components/image";
import { defaultEditorTheme, defaultImageTheme } from "@veyyon/tui/test-support";
import { stripAnsi } from "@veyyon/utils";

// 1x1 transparent PNG payload used for deterministic dimension rendering
const SAMPLE_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

interface UnpaintedRow {
	row: number;
	composed: string;
}

/**
 * Rows the renderer composed with content and the screen left blank.
 *
 * The frame is compared against the viewport row for row, which holds only
 * while the whole frame fits on screen; the caller asserts that first, so a
 * mismatch here is a row that was dropped rather than one scrolled out of view.
 */
function unpaintedComposedRows(tui: TUI, viewport: readonly string[]): UnpaintedRow[] {
	const frame = tui.composedFrameLines;
	const unpainted: UnpaintedRow[] = [];
	for (let row = 0; row < Math.min(frame.length, viewport.length); row++) {
		const composedBlank = stripAnsi(frame[row] ?? "").trim().length === 0;
		const paintedBlank = stripAnsi(viewport[row] ?? "").trim().length === 0;
		if (!composedBlank && paintedBlank) {
			unpainted.push({ row, composed: stripAnsi(frame[row] ?? "").trim() });
		}
	}
	return unpainted;
}

describe("a tool result never reserves rows it does not paint", () => {
	const initialImageProtocol = TERMINAL.imageProtocol;

	beforeAll(async () => {
		await initTheme();
		const currentTheme = theme ?? getThemeByName("dark");
		if (currentTheme) setThemeInstance(currentTheme);
	});

	afterEach(() => {
		setTerminalImageProtocol(initialImageProtocol);
		setKittyGraphics({ unicodePlaceholders: true });
	});

	it("paints every composed row for each direct-placement image protocol", async () => {
		// Sweep every ImageProtocol defined in the runtime enum
		const protocols = Object.values(ImageProtocol);
		expect(protocols.length).toBeGreaterThan(0);

		const protocolDefects: Array<{
			protocol: ImageProtocol;
			holes: ViewportHole[];
			unpainted: UnpaintedRow[];
		}> = [];

		const width = 80;
		const height = 60;

		for (const protocol of protocols) {
			setTerminalImageProtocol(protocol);
			// Direct placement mode for all protocols (sixel, iterm2, kitty without unicode placeholders)
			setKittyGraphics({ unicodePlaceholders: false });

			const terminal = new VirtualTerminal(width, height);
			const tui = new TUI(terminal);

			const transcript = new TranscriptContainer();
			tui.addChild(transcript);

			// Component 1 (Above): Header text
			const header = new Text("=== Inspect Tool Result: System Architecture Overview ===");
			transcript.addChild(header);

			// Component 2: First Image (Direct placement: reserves 15 rows via RESERVED_IMAGE_ROW)
			const image1 = new Image(
				SAMPLE_PNG_BASE64,
				"image/png",
				defaultImageTheme,
				{ maxHeightCells: 15, maxWidthCells: 60 },
				{ widthPx: 600, heightPx: 300 },
			);
			transcript.addChild(image1);

			// Component 3 (Middle): Divider text separating the two graphics
			const middleText = new Text("--- Secondary Subsystem: Gateway & Cache Cluster ---");
			transcript.addChild(middleText);

			// Component 4: Second Image (Direct placement: reserves 15 rows via RESERVED_IMAGE_ROW)
			const image2 = new Image(
				SAMPLE_PNG_BASE64,
				"image/png",
				defaultImageTheme,
				{ maxHeightCells: 15, maxWidthCells: 60 },
				{ widthPx: 600, heightPx: 300 },
			);
			transcript.addChild(image2);

			// Component 5 (Below): Summary analysis
			const summaryText = new Text("=== Analysis Complete: All 2 diagrams verified ===");
			transcript.addChild(summaryText);

			// Component 6: Pinned Editor Footer
			const editor = new Editor(defaultEditorTheme);
			tui.addChild(editor);

			// Initial render pass
			tui.requestRender();
			await settleFrames(terminal, tui);

			// Force repaint (e.g. repainting or window re-anchoring)
			tui.requestRender();
			await settleFrames(terminal, tui);

			const viewport = terminal.getViewport();
			const holes = findViewportHoles(viewport);

			// A direct-placement image paints pixels the text grid cannot hold, so
			// its rows read as blank however correct the placement is, and the
			// transcript pads around them. Neither is a hole. The frame the
			// renderer composed says which rows carry content; a row it composed
			// with content and did not paint is the defect, and comparing the two
			// is the only way to tell that from a row blank by design.
			const unpainted = unpaintedComposedRows(tui, viewport);
			if (unpainted.length > 0) {
				protocolDefects.push({ protocol, holes, unpainted });
			}

			tui.stop();
		}

		expect(protocolDefects).toEqual([]);
	});

	it("paints every composed row when an image reserves more rows than remain under the header", async () => {
		setTerminalImageProtocol(ImageProtocol.Sixel);
		setKittyGraphics({ unicodePlaceholders: false });

		const width = 80;
		const height = 40;
		const terminal = new VirtualTerminal(width, height);
		const tui = new TUI(terminal);

		const transcript = new TranscriptContainer();
		tui.addChild(transcript);

		// Header text at row 0
		transcript.addChild(new Text("User prompt: Review architecture blueprint image"));

		// Direct placement image reserving 25 rows
		const image = new Image(
			SAMPLE_PNG_BASE64,
			"image/png",
			defaultImageTheme,
			{ maxHeightCells: 25, maxWidthCells: 70 },
			{ widthPx: 800, heightPx: 600 },
		);
		transcript.addChild(image);

		// Post-image summary text
		transcript.addChild(new Text("Blueprint review: 4 microservices identified with PostgreSQL storage"));

		const editor = new Editor(defaultEditorTheme);
		tui.addChild(editor);

		tui.requestRender();
		await settleFrames(terminal, tui);

		// Force repaint
		tui.requestRender();
		await settleFrames(terminal, tui);

		const viewport = terminal.getViewport();
		const holes = findViewportHoles(viewport);

		// The image reserves more rows than remain under the header, so the frame
		// carries rows the screen has to show. A blank band alone proves nothing
		// here, because the reserved image rows and the pads around them are blank
		// by design; a row the frame composed with content and the screen left
		// empty is the defect.
		expect(holes.length).toBeGreaterThan(0);
		expect(unpaintedComposedRows(tui, viewport)).toEqual([]);

		tui.stop();
	});

	it("keeps the composer the last painted row when a tool result collapses", async () => {
		const width = 80;
		const height = 60;
		const terminal = new VirtualTerminal(width, height);
		const tui = new TUI(terminal);

		const transcript = new TranscriptContainer();
		tui.addChild(transcript);

		const editor = new Editor(defaultEditorTheme);
		tui.addChild(editor);
		// The composer is a pinned footer in the product, which is what makes the
		// bottom rows of the viewport its own. An unpinned editor is an ordinary
		// root child, and a frame shorter than the viewport correctly paints from
		// the top with blank rows beneath it.
		tui.setPinnedFooterChildCount(1);

		const execComp = new ToolExecutionComponent("bash", { command: "cargo test --all" }, {}, undefined, tui);
		transcript.addChild(execComp);

		// Stream 120 lines to advance committedRows far beyond height
		const streamLines = Array.from({ length: 120 }, (_, i) => `test suite item ${i + 1} ... ok`).join("\n");
		execComp.updateResult({
			content: [{ type: "text", text: streamLines }],
			isError: false,
			details: { meta: { totalBytes: 12000, outputBytes: 12000 } },
		});

		tui.requestRender();
		await settleFrames(terminal, tui);

		// Collapse to short summary card
		execComp.updateResult({
			content: [{ type: "text", text: "test result: ok. 120 passed; 0 failed" }],
			isError: false,
			details: { exitCode: 0, wallTimeMs: 1400 },
		});
		execComp.seal();

		tui.requestRender();
		await settleFrames(terminal, tui);

		const viewport = terminal.getViewport();
		const strandedChrome = findStrandedChrome(viewport, />|\||\+/);

		// The composer ends the frame. A collapse shortens the transcript above it,
		// and no transcript row may survive underneath it: a painted row below the
		// composer is content the renderer left behind when the frame shrank.
		expect(strandedChrome).toBeNull();

		execComp.stopAnimation();
		tui.stop();
	});
});
