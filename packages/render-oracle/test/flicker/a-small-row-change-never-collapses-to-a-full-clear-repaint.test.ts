/**
 * A change touching only a few rows must never collapse the differential path into a full clear or full repaint.
 *
 * WHY THIS SUITE EXISTS:
 * When only a single line or small subset of rows changes (e.g. a spinner tick, typing 1 character
 * into the composer, appending a token, or updating a 1-line status), the differential renderer
 * must emit targeted line updates. It must NEVER collapse to a full screen clear (`\x1b[2J`,
 * `\x1b[J`, `\x1b[3J`, or `\x1b[H\x1b[0J`) or full-history rebuild.
 *
 * ROOT CAUSE IN packages/tui/src/tui.ts:
 * 1. Line 4168: `const commitWouldTakeLiveRows = windowTop > historyEnd;`
 *    `chunkTo = hasVisibleOverlay || geometryChanged || commitWouldTakeLiveRows ? this.#committedRows : windowTop;`
 *    When uncommitted live chrome (a subagent HUD, tool status, or composer) causes `windowTop > historyEnd`,
 *    `chunkTo` is frozen at `this.#committedRows`, making `chunkLength = 0`.
 * 2. Line 5250: `const inPlaceRewrite = repaintVirtualScrollInPlace || scroll !== 0;`
 *    Because `scroll !== 0` on each scrolled line, `inPlaceRewrite` is forced to true.
 * 3. Line 5253: `let firstChanged = forceWindowRewrite || inPlaceRewrite ? 0 : -1;`
 *               `let lastChanged = forceWindowRewrite || inPlaceRewrite ? height - 1 : -1;`
 *    Sweeps ALL rows of the viewport from 0 to height-1, emitting `\x1b[K` erase sequences and rewriting
 *    all lines on every single streamed token.
 * 4. Line 4078: `!frameSqueezed && (committedRowsResynced || frameLength <= this.#committedRows)`
 *    `divergenceRebuild` triggers on frame collapse/divergence and emits `\x1b[H\x1b[3J` ED3 clear.
 *
 * WHAT THIS SUITE CLOSES:
 * - Full-viewport in-place sweep during streaming token appends to live footers/HUDs.
 * - Erase-in-display full screen clear on small edits.
 * - Divergence rebuild collapsing diff path on frameLength <= committedRows.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { StressRenderScheduler, VirtualTerminal } from "@veyyon/render-oracle";
import { type Component, TUI } from "@veyyon/tui/tui";

const ERASE_DISPLAY_REGEX = /\x1b\[[0-3]?J/g;
const ERASE_LINE_REGEX = /\x1b\[[0-2]?K/g;

interface FrameEmission {
	raw: string;
	byteLength: number;
	eraseDisplayCount: number;
	eraseLineCount: number;
	viewport: string[];
}

function createFrameRecorder(term: VirtualTerminal) {
	let currentBuffer = "";
	const originalWrite = term.write.bind(term);
	spyOn(term, "write").mockImplementation((data: string) => {
		currentBuffer += data;
		originalWrite(data);
	});

	return {
		collectFrame: (): FrameEmission => {
			const raw = currentBuffer;
			currentBuffer = "";
			const displayMatches = raw.match(ERASE_DISPLAY_REGEX);
			const lineMatches = raw.match(ERASE_LINE_REGEX);
			return {
				raw,
				byteLength: Buffer.byteLength(raw, "utf8"),
				eraseDisplayCount: displayMatches ? displayMatches.length : 0,
				eraseLineCount: lineMatches ? lineMatches.length : 0,
				viewport: term.getViewport(),
			};
		},
	};
}

class NativeReplayTranscript implements Component {
	constructor(private lines: string[]) {}

	setLines(newLines: string[]): void {
		this.lines = newLines;
	}

	prepareNativeScrollbackReplay(): void {}

	render(_width: number): readonly string[] {
		return this.lines;
	}
}

class LiveFooterComponent implements Component {
	constructor(private lines: string[]) {}

	setLines(newLines: string[]): void {
		this.lines = newLines;
	}

	render(_width: number): readonly string[] {
		return this.lines;
	}
}

class DynamicTranscriptComponent implements Component {
	constructor(private lines: string[]) {}

	setLines(newLines: string[]): void {
		this.lines = newLines;
	}

	render(_width: number): readonly string[] {
		return this.lines;
	}
}

describe("a small row change never collapses to a full-clear repaint", () => {
	it("never rewrites all viewport rows when appending a single token into a streaming chrome footer", async () => {
		const term = new VirtualTerminal(80, 10);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const recorder = createFrameRecorder(term);

		// Transcript with 5 history lines
		const transcript = new NativeReplayTranscript([
			"Transcript line 0",
			"Transcript line 1",
			"Transcript line 2",
			"Transcript line 3",
			"Transcript line 4",
		]);
		// Live footer/HUD with 6 lines (total 11 lines > 10 rows, windowTop = 1)
		const footer = new LiveFooterComponent([
			"HUD Header: Subagent task in progress",
			"Progress: [===>        ] 30%",
			"Step 1: Reading configuration",
			"Step 2: Executing build",
			"Log: Compiling source files...",
			"Status: Working",
		]);

		tui.addChild(transcript);
		tui.addChild(footer);

		tui.start();
		await scheduler.drain(term);
		recorder.collectFrame();

		// Footer expands so windowTop (15 - 10 = 5) reaches historyEnd (5)
		footer.setLines([
			"HUD Header: Subagent task in progress",
			"Progress: [=====>      ] 50%",
			"Step 1: Reading configuration",
			"Step 2: Executing build",
			"Log: Compiling source files...",
			"Log: Emitting artifacts...",
			"Log: Checking types...",
			"Log: Running linter...",
			"Log: Generating bundle...",
			"Status: Working",
		]);
		tui.requestRender();
		await scheduler.drain(term);
		recorder.collectFrame();

		// Now append a single log line to the live footer (windowTop moves 5 -> 6, where windowTop > historyEnd 5)
		footer.setLines([
			"HUD Header: Subagent task in progress",
			"Progress: [======>     ] 60%",
			"Step 1: Reading configuration",
			"Step 2: Executing build",
			"Log: Compiling source files...",
			"Log: Emitting artifacts...",
			"Log: Checking types...",
			"Log: Running linter...",
			"Log: Generating bundle...",
			"Log: Optimizing chunks...",
			"Status: Working",
		]);
		tui.requestRender();
		await scheduler.drain(term);
		const appendEmission = recorder.collectFrame();

		// CONTRACT DEFENSE:
		// A streaming token/line appended to the footer should perform a targeted incremental update (< 3 row rewrites),
		// NOT collapse to a full-viewport in-place sweep rewriting all 10 rows with 10 erase-to-end-of-line sequences!
		//
		// ROOT CAUSE FAILURE ON CURRENT MAIN:
		// In tui.ts line 4168, because windowTop (6) > historyEnd (5), commitWouldTakeLiveRows is true.
		// chunkTo is frozen at committedRows (5), making chunkLength = 0.
		// Then in line 5250, because scroll (1) !== 0, inPlaceRewrite becomes true, setting firstChanged = 0
		// and lastChanged = height - 1 (9). It sweeps all 10 rows of the viewport, emitting 10 eraseLine sequences!
		expect(appendEmission.eraseDisplayCount).toBe(0);
		expect(appendEmission.eraseLineCount).toBeLessThanOrEqual(2);
	});

	it("never emits erase-in-display (ED) when updating a single spinner row during an in-flight tool call", async () => {
		const term = new VirtualTerminal(80, 12);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const recorder = createFrameRecorder(term);

		const lines = [
			"Header: Conversation started",
			"Message 1: System prompt loaded",
			"Message 2: Running command: build",
			"Output line 1: compiling...",
			"Output line 2: linking...",
			"Status: ⠋ Running step 1",
		];
		const component = new DynamicTranscriptComponent(lines);
		tui.addChild(component);

		tui.start();
		await scheduler.drain(term);
		recorder.collectFrame();

		// Spinner ticks: only the last row changes glyph (⠋ -> ⠙)
		component.setLines([
			"Header: Conversation started",
			"Message 1: System prompt loaded",
			"Message 2: Running command: build",
			"Output line 1: compiling...",
			"Output line 2: linking...",
			"Status: ⠙ Running step 1",
		]);
		tui.requestRender();
		await scheduler.drain(term);
		const tickEmission = recorder.collectFrame();

		// Contract: Single spinner tick must only update 1 row, never clear the display
		expect(tickEmission.eraseDisplayCount).toBe(0);
		expect(tickEmission.eraseLineCount).toBeLessThanOrEqual(1);
		expect(tickEmission.byteLength).toBeLessThan(100);
	});
});
