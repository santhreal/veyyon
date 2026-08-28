/**
 * A frame that writes no content leaves the physical cursor where it was.
 *
 * WHY THIS SUITE EXISTS. The engine tracks the hardware cursor as a FRAME-absolute
 * row and derives every relative move from it. A frame that slides the window
 * without painting — an overlay holding the commit, a frozen scroll view — changes
 * which frame row sits under the physical cursor without moving the cursor at all.
 * The cursor write on that frame compared the new frame row against the old one and
 * emitted a one-row CUD for a cursor that had not moved, so the physical cursor
 * walked one row further from the tracked row on every such frame. The next frame
 * that committed rows then scrolled from an origin two rows too high: it pushed
 * uncommitted rows — overlay content among them — into native scrollback, which the
 * stress driver reports as `tape/physical scroll parity`
 * (`darwin-normal-reflow-small` seed 0xf1faf0be).
 *
 * THE CLASS. Not "hiding an overlay": any frame whose emission paints nothing while
 * the window slides. The invariant is state-relative and needs no expected geometry
 * — a frame that wrote no printable row, no erase and no scroll leaves the terminal's
 * own cursor position untouched, and the rows that reach scrollback stay a prefix of
 * the transcript that produced them. Both paintless-slide sources are swept (visible
 * overlay, frozen scroll view) at several viewport heights and slide distances.
 *
 * WHAT IT DOES NOT CATCH. A frame that does paint: its cursor origin is the row it
 * just wrote, which is a different derivation. Nor does it judge where the cursor
 * ends up when the frame legitimately scrolls, which is the scrollback suites'
 * question.
 */
import { describe, expect, it } from "bun:test";
import { createFrameRecorder, StressRenderScheduler, VirtualTerminal } from "@veyyon/render-oracle";
import { type Component, CURSOR_MARKER, type Focusable, TUI } from "@veyyon/tui/tui";

class Transcript implements Component {
	#lines: string[];
	constructor(lines: readonly string[]) {
		this.#lines = [...lines];
	}
	setLines(lines: readonly string[]): void {
		this.#lines = [...lines];
	}
	invalidate(): void {}
	render(): readonly string[] {
		return [...this.#lines];
	}
}

/** A focused overlay carrying the hardware cursor, as a modal editor does. */
class CursorOverlay implements Component, Focusable {
	focused = true;
	constructor(private readonly lines: readonly string[]) {}
	invalidate(): void {}
	setUseTerminalCursor(): void {}
	handleInput(): void {}
	render(): readonly string[] {
		return this.lines.map((line, index) => (index === 1 ? `${line}${CURSOR_MARKER}` : line));
	}
}

interface PaintlessFrame {
	step: number;
	cursorBefore: number;
	cursorAfter: number;
	bytes: string;
}

function painted(emission: { rowsRewritten: number; eraseDisplayCount: number; eraseLineCount: number }): boolean {
	return emission.rowsRewritten > 0 || emission.eraseDisplayCount > 0 || emission.eraseLineCount > 0;
}

describe("a frame that paints nothing never moves the physical cursor", () => {
	for (const height of [4, 8, 12] as const) {
		for (const rowsPerStep of [1, 2] as const) {
			it(`holds the cursor across ${rowsPerStep}-row slides under an overlay in a ${height}-row viewport`, async () => {
				const term = new VirtualTerminal(40, height);
				const scheduler = new StressRenderScheduler();
				const tui = new TUI(term, true, { renderScheduler: scheduler });
				const recorder = createFrameRecorder(term);
				const lines = Array.from({ length: height * 3 }, (_, i) => `line-${i}`);
				const transcript = new Transcript(lines);
				tui.addChild(transcript);
				tui.start();
				await scheduler.drain(term);
				recorder.collectFrame();

				const overlay = new CursorOverlay(Array.from({ length: height }, (_, i) => `OV_SENTINEL_${i}`));
				tui.showOverlay(overlay, { row: 0, col: 0, width: 30 });
				tui.setFocus(overlay);
				tui.requestRender();
				await scheduler.drain(term);
				recorder.collectFrame();

				const paintless: PaintlessFrame[] = [];
				const drifted: PaintlessFrame[] = [];
				for (let step = 0; step < 6; step++) {
					for (let row = 0; row < rowsPerStep; row++) lines.push(`grown-${step}-${row}`);
					transcript.setLines(lines);
					const cursorBefore = term.getCursor().row;
					tui.requestRender();
					await scheduler.drain(term);
					const emission = recorder.collectFrame();
					if (painted(emission)) continue;
					const frame: PaintlessFrame = {
						step,
						cursorBefore,
						cursorAfter: term.getCursor().row,
						bytes: JSON.stringify(emission.raw),
					};
					paintless.push(frame);
					if (frame.cursorAfter !== frame.cursorBefore) drifted.push(frame);
				}

				// CONTRACT DEFENSE: the arm only proves something if the slides really
				// painted nothing, and then no such frame moved the terminal's cursor.
				expect(paintless.length).toBeGreaterThan(0);
				expect(drifted).toEqual([]);

				tui.stop();
				await term.flush();
			});
		}
	}

	it("keeps overlay rows out of scrollback when the commit lands after a run of paintless slides", async () => {
		const term = new VirtualTerminal(40, 4);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		const lines = Array.from({ length: 12 }, (_, i) => `line-${i}`);
		const transcript = new Transcript(lines);
		tui.addChild(transcript);
		tui.start();
		await scheduler.drain(term);

		const overlay = new CursorOverlay(["OV_SENTINEL_0", "OV_SENTINEL_1", "OV_SENTINEL_2", "OV_SENTINEL_3"]);
		const handle = tui.showOverlay(overlay, { row: 0, col: 0, width: 30 });
		tui.setFocus(overlay);
		tui.requestRender();
		await scheduler.drain(term);

		// Slide the window under the overlay, then tear it down on a frame that
		// commits: the teardown is where a drifted cursor scrolls too far.
		for (let step = 0; step < 6; step++) {
			lines.push(`grown-${step}`);
			transcript.setLines(lines);
			tui.requestRender();
			await scheduler.drain(term);
		}
		lines.push("after-overlay-0", "after-overlay-1");
		transcript.setLines(lines);
		handle.hide();
		tui.requestRender();
		await scheduler.drain(term);

		// CONTRACT DEFENSE: everything that reached history is a transcript row, in
		// transcript order. Read off the terminal against the component's own lines,
		// so the arm asserts no geometry of its own.
		const position = term.getBufferPosition();
		const history = term
			.getScrollBuffer()
			.slice(0, position.baseY)
			.map(row => Bun.stripANSI(row).trimEnd());
		expect(history).toEqual(lines.slice(0, history.length));

		tui.stop();
		await term.flush();
	});
});
