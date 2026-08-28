/**
 * A change touching a few rows repaints those rows and no others.
 *
 * WHY THIS SUITE EXISTS: a frame that cannot commit — live chrome below the history end, a
 * visible overlay, a frozen scroll view — took a path that decided how much to repaint from the
 * KIND of frame rather than from what changed on screen. Every streamed token then erased and
 * reprinted the whole viewport, which is the strobe a user sees while a tool streams.
 *
 * WHAT IT CLOSES: the full-viewport sweep during a streaming append, an erase-in-display on a
 * small edit, and a slide that repaints the rows it scrolled past when their bytes did not move.
 *
 * WHAT IT DOES NOT CATCH: how the terminal schedules the bytes it is handed, so a repaint that
 * is minimal here can still tear over a link slow enough to split it.
 */

import { describe, expect, it } from "bun:test";
import { createFrameRecorder, StressRenderScheduler, VirtualTerminal } from "@veyyon/render-oracle";
import { type Component, TUI } from "@veyyon/tui/tui";

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
		const beforeAppend = recorder.collectFrame().viewport.map(row => row.trimEnd());

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
		// The frame may rewrite a row it changed; it may not erase one it did not. The budget is
		// the number of rows whose painted bytes actually differ between the two frames, read off
		// the terminal rather than written into the test, so a window that slides by a row is
		// allowed the rows the slide really moved and nothing more.
		const afterAppend = appendEmission.viewport.map(row => row.trimEnd());
		const rowsThatChanged = afterAppend.filter((row, index) => row !== beforeAppend[index]).length;

		expect(rowsThatChanged).toBeGreaterThan(0);
		expect(appendEmission.eraseDisplayCount).toBe(0);
		expect(appendEmission.eraseLineCount).toBeLessThanOrEqual(rowsThatChanged);
	});

	it("repaints one changed row of a viewport of identical rows while an overlay holds the frame", async () => {
		// An open overlay stops the frame committing, so the whole viewport is rewritten in
		// place from a clamped top. Repeated filler is what separates a targeted rewrite from a
		// total one: nine rows carry the same bytes before and after, so a walk that reprints
		// what it steps over is visible as nine rows nobody asked for.
		const term = new VirtualTerminal(80, 10);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const recorder = createFrameRecorder(term);

		const filler = (count: number) => Array.from({ length: count }, () => "idle");
		const content = new LiveFooterComponent([...filler(9), "Status: Working"]);
		tui.addChild(content);

		tui.start();
		await scheduler.drain(term);
		tui.showOverlay(new NativeReplayTranscript(["┌ busy ┐"]), { width: 10, maxHeight: 1, anchor: "center" });
		await scheduler.drain(term);
		const beforeTick = recorder.collectFrame().viewport.map(row => row.trimEnd());

		content.setLines([...filler(9), "Status: Done"]);
		tui.requestRender();
		await scheduler.drain(term);
		const tick = recorder.collectFrame();

		const afterTick = tick.viewport.map(row => row.trimEnd());
		const rowsThatChanged = afterTick.filter((row, index) => row !== beforeTick[index]).length;

		expect(rowsThatChanged).toBeGreaterThan(0);
		expect(rowsThatChanged).toBeLessThan(afterTick.length);
		expect(tick.eraseDisplayCount).toBe(0);
		expect(tick.eraseLineCount).toBeLessThanOrEqual(rowsThatChanged);
		expect(tick.rowsRewritten).toBeLessThanOrEqual(rowsThatChanged);
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
		const beforeTick = recorder.collectFrame().viewport.map(row => row.trimEnd());

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

		// Contract: the tick repaints the row whose glyph moved, and no row that did not.
		const afterTick = tickEmission.viewport.map(row => row.trimEnd());
		const rowsThatChanged = afterTick.filter((row, index) => row !== beforeTick[index]).length;
		expect(rowsThatChanged).toBe(1);
		expect(tickEmission.eraseDisplayCount).toBe(0);
		expect(tickEmission.eraseLineCount).toBeLessThanOrEqual(rowsThatChanged);
		expect(tickEmission.rowsRewritten).toBeLessThanOrEqual(rowsThatChanged);
	});
});
