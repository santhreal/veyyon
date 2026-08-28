/**
 * A frame identical to the one on screen writes nothing.
 *
 * WHY THIS SUITE EXISTS: a scheduled tick, an external render request, an open overlay or a
 * frozen scroll view produced a frame the diff never got to see, because the repaint span was
 * widened to the whole viewport before anything was compared. The result was an erase and a
 * reprint of every row to arrive back at the bytes already there — a full-screen strobe with no
 * visible change behind it.
 *
 * WHAT IT CLOSES: a redundant repaint on an identical frame under an overlay, under an active
 * virtual-scroll slice, and on an idle render request against unchanged content.
 *
 * WHAT IT DOES NOT CATCH: a frame that differs by one cell, which is the neighbouring suite's
 * subject, and the cursor bytes a render is still entitled to write.
 */

import { describe, expect, it } from "bun:test";
import { createFrameRecorder, StressRenderScheduler, VirtualTerminal } from "@veyyon/render-oracle";
import { type Component, TUI } from "@veyyon/tui/tui";

class StaticContentComponent implements Component {
	constructor(private readonly lines: readonly string[]) {}

	render(_width: number): readonly string[] {
		return this.lines;
	}
}

describe("an identical frame never emits erase or printable bytes", () => {
	it("emits 0 erase sequences and 0 text row rewrites when re-rendering with an active overlay", async () => {
		const term = new VirtualTerminal(60, 10);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const recorder = createFrameRecorder(term);

		const base = new StaticContentComponent([
			"Row 0: Base transcript content",
			"Row 1: Second line of persistent text",
			"Row 2: Third line of persistent text",
			"Row 3: Fourth line of persistent text",
			"Row 4: Bottom status area",
		]);
		tui.addChild(base);

		const overlay = new StaticContentComponent([
			"┌──────────────────────────────┐",
			"│ Autocomplete / Modal Dialog  │",
			"└──────────────────────────────┘",
		]);

		tui.start();
		await scheduler.drain(term);
		const frame0 = recorder.collectFrame();
		expect(frame0.byteLength).toBeGreaterThan(0);

		// Frame 1: Mount the overlay
		tui.showOverlay(overlay, { width: 32, maxHeight: 3, anchor: "center" });
		await scheduler.drain(term);
		const frame1 = recorder.collectFrame();
		expect(frame1.byteLength).toBeGreaterThan(0);

		// Frame 2: Trigger a re-render where NOTHING has changed
		tui.requestRender();
		await scheduler.drain(term);
		const frame2 = recorder.collectFrame();

		// Defect check: Frame 2 is byte-for-byte visually identical to Frame 1.
		expect(frame2.viewport).toEqual(frame1.viewport);

		// Contract: An identical frame must NOT emit full-window row erases or text rewrites.
		// On current main, lines 4345 and 5250 force inPlaceRewrite = true whenever an overlay is visible,
		// causing it to emit height (10) \x1b[K erases and rewrite all 10 lines.
		expect(frame2.eraseLineCount).toBe(0);
		expect(frame2.byteLength).toBe(0);
	});

	it("emits 0 erase sequences when requestRender is called on an unchanged container", async () => {
		const term = new VirtualTerminal(80, 12);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const recorder = createFrameRecorder(term);
		const content = new StaticContentComponent([
			"System initialized: ready for input",
			"Model: default-agent-v1",
			"Waiting for prompt...",
		]);
		tui.addChild(content);

		tui.start();
		await scheduler.drain(term);
		const initialFrame = recorder.collectFrame();
		expect(initialFrame.byteLength).toBeGreaterThan(0);

		// Subsequent idle requestRender
		tui.requestRender();
		await scheduler.drain(term);
		const idleFrame = recorder.collectFrame();

		expect(idleFrame.viewport).toEqual(initialFrame.viewport);
		expect(idleFrame.eraseLineCount).toBe(0);
		expect(idleFrame.eraseDisplayCount).toBe(0);
		expect(idleFrame.byteLength).toBe(0);
	});

	it("emits 0 erase sequences and 0 text rewrites when re-rendering with active virtual scrollback slice", async () => {
		const term = new VirtualTerminal(60, 10);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const recorder = createFrameRecorder(term);

		// Create enough rows to overflow the 10-row viewport and commit to scrollback
		const rows = Array.from(
			{ length: 25 },
			(_, i) => `Row ${i.toString().padStart(2, "0")}: transcript history entry`,
		);
		const content = new StaticContentComponent(rows);
		tui.addChild(content);

		tui.start();
		// Enable scroll isolation and scroll back into history (virtual scroll active)
		tui.setScrollIsolation(true);
		await scheduler.drain(term);
		recorder.collectFrame();

		const scrolled = tui.scrollByRows(-3);
		expect(scrolled).toBe(true);
		await scheduler.drain(term);
		const scrolledFrame = recorder.collectFrame();
		expect(scrolledFrame.byteLength).toBeGreaterThan(0);

		// Subsequent idle requestRender while scrolled into history
		tui.requestRender();
		await scheduler.drain(term);
		const idleFrozenFrame = recorder.collectFrame();

		// Contract: Viewport is unchanged, so 0 erase sequences and 0 bytes must be emitted
		expect(idleFrozenFrame.viewport).toEqual(scrolledFrame.viewport);
		expect(idleFrozenFrame.eraseLineCount).toBe(0);
		expect(idleFrozenFrame.byteLength).toBe(0);
	});
});
