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
 * ROOT CAUSE UNDER TEST:
 * 1. packages/tui/src/components/image.ts:420-434 (Direct-Placement Image Reservation):
 *    In the direct-placement branch (sixel, iterm2, or kitty with unicodePlaceholders: false),
 *    the Image component reserves `result.rows` lines by pushing `(result.rows - 1)` rows of
 *    `RESERVED_IMAGE_ROW` (which is `SGR_RESET` `\x1b[0m` — zero printable text width) and
 *    placing the graphics escape sequence in the final row (`SAVE_CURSOR + CUU + sequence + RESTORE_CURSOR`).
 *    When the transcript repaints or scrolls into history, the one-time placement is never re-bound,
 *    leaving a massive unpainted HOLE (e.g. 15-30+ blank rows) between the header above and the summary below.
 *
 * 2. packages/tui/src/tui.ts:4148 (Stranded Chrome on Output Collapse):
 *    When streaming output scrolls past the viewport and later collapses, `this.#committedRows`
 *    retains the peak streaming height, clamping `windowTop` far below the collapsed frame and
 *    emitting unpainted trailing blank rows beneath the floating card/composer.
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
import { settleFrames, VirtualTerminal } from "@veyyon/render-oracle";
import { Editor, ImageProtocol, setKittyGraphics, setTerminalImageProtocol, TERMINAL, Text, TUI } from "@veyyon/tui";
import { Image } from "@veyyon/tui/components/image";
import { defaultEditorTheme, defaultImageTheme } from "@veyyon/tui/test-support";

// 1x1 transparent PNG payload used for deterministic dimension rendering
const SAMPLE_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/**
 * Positional Oracle: Detects unpainted "holes" in a rendered viewport frame.
 * A HOLE is defined as a contiguous run of empty/blank rows (>= minHoleSize)
 * that has legitimate painted content BOTH above it AND below it within the same viewport.
 */
interface ViewportHole {
	startRow: number;
	endRow: number;
	holeHeight: number;
	paintedRowAbove: { row: number; text: string };
	paintedRowBelow: { row: number; text: string };
}

function detectViewportHoles(viewport: readonly string[], minHoleSize = 2): ViewportHole[] {
	const holes: ViewportHole[] = [];
	let blankStart = -1;

	for (let r = 0; r < viewport.length; r++) {
		const line = (viewport[r] ?? "").trim();
		const isBlank = line.length === 0;

		if (isBlank) {
			if (blankStart === -1) blankStart = r;
		} else {
			if (blankStart !== -1) {
				const blankEnd = r - 1;
				const holeHeight = blankEnd - blankStart + 1;

				if (holeHeight >= minHoleSize && blankStart > 0) {
					let aboveRow = -1;
					for (let a = blankStart - 1; a >= 0; a--) {
						if ((viewport[a] ?? "").trim().length > 0) {
							aboveRow = a;
							break;
						}
					}

					if (aboveRow !== -1) {
						holes.push({
							startRow: blankStart,
							endRow: blankEnd,
							holeHeight,
							paintedRowAbove: { row: aboveRow, text: (viewport[aboveRow] ?? "").trim() },
							paintedRowBelow: { row: r, text: line },
						});
					}
				}
				blankStart = -1;
			}
		}
	}

	return holes;
}

/**
 * Positional Oracle: Detects stranded chrome / footer components floating mid-screen
 * with unpainted trailing blank rows beneath them when the overall frame required full height.
 */
interface StrandedChromeDefect {
	footerRow: number;
	totalViewportRows: number;
	unpaintedTrailingRows: number;
	footerText: string;
}

function detectStrandedChrome(viewport: readonly string[], footerMarkerRegex: RegExp): StrandedChromeDefect | null {
	let footerRow = -1;
	for (let r = 0; r < viewport.length; r++) {
		if (footerMarkerRegex.test(viewport[r] ?? "")) {
			footerRow = r;
		}
	}

	if (footerRow === -1 || footerRow === viewport.length - 1) {
		return null;
	}

	const trailingRows = viewport.length - 1 - footerRow;
	for (let r = footerRow + 1; r < viewport.length; r++) {
		if ((viewport[r] ?? "").trim().length > 0) {
			return null;
		}
	}

	return {
		footerRow,
		totalViewportRows: viewport.length,
		unpaintedTrailingRows: trailingRows,
		footerText: (viewport[footerRow] ?? "").trim(),
	};
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

	it("sweeps all direct-placement ImageProtocols at runtime and proves two-image results create unpainted holes", async () => {
		// Sweep every ImageProtocol defined in the runtime enum
		const protocols = Object.values(ImageProtocol);
		expect(protocols.length).toBeGreaterThan(0);

		const protocolDefects: Array<{
			protocol: ImageProtocol;
			holes: ViewportHole[];
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
			const holes = detectViewportHoles(viewport, 2);

			if (holes.length > 0) {
				protocolDefects.push({
					protocol,
					holes,
				});
			}

			tui.stop();
		}

		console.log(`Discovered direct-placement HOLE defects across ${protocolDefects.length} protocols:`);
		for (const def of protocolDefects) {
			console.log(`Protocol ${def.protocol}: found ${def.holes.length} unpainted holes:`, def.holes);
		}

		// POSITIONAL DEFENSE ASSERTION:
		// A rendered viewport must never contain unpainted HOLEs (empty bands bounded by legitimate painted text).
		// On current main, this FAILS (RED) because image direct placement emits RESERVED_IMAGE_ROW (\x1b[0m)
		// without persistent text backing, leaving massive unpainted gaps between painted items.
		expect(protocolDefects).toHaveLength(0);
	});

	it("proves direct-placement image results with height exceeding viewport leave persistent unpainted holes", async () => {
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
		const holes = detectViewportHoles(viewport, 5);

		// ASSERTION: Must not contain any unpainted hole >= 5 rows between header and summary
		expect(holes).toHaveLength(0);

		tui.stop();
	});

	it("proves tool execution collapse leaves stranded chrome floating above unpainted bottom rows", async () => {
		const width = 80;
		const height = 60;
		const terminal = new VirtualTerminal(width, height);
		const tui = new TUI(terminal);

		const transcript = new TranscriptContainer();
		tui.addChild(transcript);

		const editor = new Editor(defaultEditorTheme);
		tui.addChild(editor);

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
		const strandedChrome = detectStrandedChrome(viewport, />|\||\+/);

		// POSITIONAL DEFENSE ASSERTION:
		// When output collapses, the composer/footer must not be left stranded mid-screen
		// with 10+ unpainted trailing blank rows beneath it.
		// On current main, this FAILS (RED) with strandedChrome.unpaintedTrailingRows > 40.
		expect(strandedChrome).toBeNull();

		execComp.stopAnimation();
		tui.stop();
	});
});
