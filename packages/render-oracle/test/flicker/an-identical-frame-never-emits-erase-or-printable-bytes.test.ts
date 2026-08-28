/**
 * An unchanged frame must never emit erase escape sequences or printable text bytes.
 *
 * WHY THIS SUITE EXISTS:
 * When an identical frame re-renders (a scheduled tick, an external requestRender,
 * an in-flight overlay, or a virtualized scroll state where content did not change),
 * the differential renderer should detect that zero visual rows changed and emit
 * nothing (or at most hardware cursor positioning bytes).
 *
 * ROOT CAUSE IN packages/tui/src/tui.ts:
 * 1. Line 4345: `repaintVirtualScrollInPlace: hasVisibleOverlay || virtualScrollSlice`
 * 2. Line 5250: `const inPlaceRewrite = repaintVirtualScrollInPlace || scroll !== 0;`
 * 3. Line 5253: `let firstChanged = forceWindowRewrite || inPlaceRewrite ? 0 : -1;`
 *               `let lastChanged = forceWindowRewrite || inPlaceRewrite ? height - 1 : -1;`
 * 4. Line 5296: When `inPlaceRewrite` is true, every row `0..height-1` is rewritten with
 *    `\x1b[K` (erase to end of line) and printable character bytes on every single frame,
 *    even when the entire window is 100% identical to the previous frame.
 * 5. Line 5271: `buffer += \x1b[${height - 1}A\r` moves the cursor to the top row and sweeps
 *    down, causing visible full-screen flashing / strobe across the entire terminal.
 *
 * WHAT THIS SUITE CLOSES:
 * - Redundant erase/printable emission on identical frames during active overlays.
 * - Redundant full-screen row rewrites when virtual scroll position is unchanged.
 * - Redundant paints triggered by external `requestRender(false)` when content is identical.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { StressRenderScheduler, VirtualTerminal } from "@veyyon/render-oracle";
import { type Component, TUI } from "@veyyon/tui/tui";

const ERASE_LINE_REGEX = /\x1b\[[0-2]?K/g;
const ERASE_DISPLAY_REGEX = /\x1b\[[0-3]?J/g;

interface RecordedFrame {
	index: number;
	raw: string;
	byteLength: number;
	eraseLineSequences: number;
	eraseDisplaySequences: number;
	viewport: string[];
}
function createFrameRecorder(term: VirtualTerminal) {
	const frames: RecordedFrame[] = [];
	let currentBuffer = "";
	const originalWrite = term.write.bind(term);
	spyOn(term, "write").mockImplementation((data: string) => {
		currentBuffer += data;
		originalWrite(data);
	});
	const recordFrame = (): RecordedFrame => {
		const raw = currentBuffer;
		currentBuffer = "";
		const eraseLineMatches = raw.match(ERASE_LINE_REGEX);
		const eraseDisplayMatches = raw.match(ERASE_DISPLAY_REGEX);
		const frame: RecordedFrame = {
			index: frames.length,
			raw,
			byteLength: Buffer.byteLength(raw, "utf8"),
			eraseLineSequences: eraseLineMatches ? eraseLineMatches.length : 0,
			eraseDisplaySequences: eraseDisplayMatches ? eraseDisplayMatches.length : 0,
			viewport: term.getViewport(),
		};
		frames.push(frame);
		return frame;
	};

	return { frames, recordFrame };
}

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
		const frame0 = recorder.recordFrame();
		expect(frame0.byteLength).toBeGreaterThan(0);

		// Frame 1: Mount the overlay
		tui.showOverlay(overlay, { width: 32, maxHeight: 3, anchor: "center" });
		await scheduler.drain(term);
		const frame1 = recorder.recordFrame();
		expect(frame1.byteLength).toBeGreaterThan(0);

		// Frame 2: Trigger a re-render where NOTHING has changed
		tui.requestRender();
		await scheduler.drain(term);
		const frame2 = recorder.recordFrame();

		// Defect check: Frame 2 is byte-for-byte visually identical to Frame 1.
		expect(frame2.viewport).toEqual(frame1.viewport);

		// Contract: An identical frame must NOT emit full-window row erases or text rewrites.
		// On current main, lines 4345 and 5250 force inPlaceRewrite = true whenever an overlay is visible,
		// causing it to emit height (10) \x1b[K erases and rewrite all 10 lines.
		expect(frame2.eraseLineSequences).toBe(0);
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
		const initialFrame = recorder.recordFrame();
		expect(initialFrame.byteLength).toBeGreaterThan(0);

		// Subsequent idle requestRender
		tui.requestRender();
		await scheduler.drain(term);
		const idleFrame = recorder.recordFrame();

		expect(idleFrame.viewport).toEqual(initialFrame.viewport);
		expect(idleFrame.eraseLineSequences).toBe(0);
		expect(idleFrame.eraseDisplaySequences).toBe(0);
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
		recorder.recordFrame();

		const scrolled = tui.scrollByRows(-3);
		expect(scrolled).toBe(true);
		await scheduler.drain(term);
		const scrolledFrame = recorder.recordFrame();
		expect(scrolledFrame.byteLength).toBeGreaterThan(0);

		// Subsequent idle requestRender while scrolled into history
		tui.requestRender();
		await scheduler.drain(term);
		const idleFrozenFrame = recorder.recordFrame();

		// Contract: Viewport is unchanged, so 0 erase sequences and 0 bytes must be emitted
		expect(idleFrozenFrame.viewport).toEqual(scrolledFrame.viewport);
		expect(idleFrozenFrame.eraseLineSequences).toBe(0);
		expect(idleFrozenFrame.byteLength).toBe(0);
	});
});
