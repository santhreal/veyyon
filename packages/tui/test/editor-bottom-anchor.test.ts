import { describe, expect, it } from "bun:test";
import { type Component, CURSOR_MARKER, type Focusable, TUI } from "@veyyon/tui";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

// Regression for the editor ungluing from the viewport bottom when a tall
// transient prompt (the ask dialog's "type your own" editor) collapses back to
// the one-line editor. The tall prompt scrolls transcript rows into native
// scrollback; on collapse the frame shrinks but no committed row changed, so
// no prefix resync fires and windowTop floors at #committedRows, stranding the
// editor mid-screen with blank rows underneath (user report 2026-07-22). The
// engine's own contract says duplication in history is preferable to a live
// editor gap, so the tail must be re-shown and the editor re-anchored.

class Transcript implements Component {
	lines: string[] = [];

	invalidate(): void {}

	render(_width: number): readonly string[] {
		return this.lines;
	}
}

class Editor implements Component, Focusable {
	focused = false;
	lines: string[] = ["> "];

	invalidate(): void {}

	setUseTerminalCursor(): void {}

	render(_width: number): readonly string[] {
		return [...this.lines.slice(0, -1), this.lines[this.lines.length - 1]! + CURSOR_MARKER];
	}
}

function rows(prefix: string, n: number): string[] {
	return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

function viewportText(term: VirtualTerminal): string[] {
	return term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
}

describe("editor bottom anchor on transient prompt collapse", () => {
	it("re-anchors the editor at the viewport bottom after a tall prompt collapses", async () => {
		const height = 10;
		const term = new VirtualTerminal(40, height, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		const transcript = new Transcript();
		const editor = new Editor();
		tui.addChild(transcript);
		tui.addChild(editor);
		tui.setFocus(editor);

		// 8 transcript rows + 1 editor row: frame fits the viewport exactly.
		transcript.lines = rows("hist-", 8);

		try {
			tui.start();
			await scheduler.drain(term);

			// The ask dialog's inline prompt grows to 6 rows, scrolling the
			// transcript: frame 8 + 6 = 14 > 10, so hist-0..3 commit to native
			// scrollback.
			editor.lines = [...rows("prompt-", 5), "> "];
			tui.requestRender();
			await scheduler.drain(term);

			// Submit: the tall prompt is replaced by the one-line editor. The
			// frame collapses to 9 rows. The committed transcript rows did not
			// change, so no resync fires; the editor must still sit at the
			// viewport bottom, not float mid-screen above blank rows.
			editor.lines = ["> "];
			tui.requestRender();
			await scheduler.drain(term);

			const view = viewportText(term);
			const editorRow = view.indexOf(">");
			expect(editorRow).toBeGreaterThanOrEqual(0);
			// Every row below the editor must be empty (no transcript below it),
			// and the blank tail must be at most the viewport minus frame length:
			// the editor is bottom-anchored, so it sits at row frameLength - 1
			// from the window top, with only the unavoidable short-frame padding
			// beneath it. A float shows the editor several rows up with a tall
			// blank slab below.
			const blanksBelow = view.length - 1 - editorRow;
			expect(blanksBelow).toBeLessThanOrEqual(height - (transcript.lines.length + editor.lines.length));
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("keeps the editor anchored across repeated grow/collapse cycles", async () => {
		const height = 10;
		const term = new VirtualTerminal(40, height, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		const transcript = new Transcript();
		const editor = new Editor();
		tui.addChild(transcript);
		tui.addChild(editor);
		tui.setFocus(editor);

		transcript.lines = rows("hist-", 8);

		try {
			tui.start();
			await scheduler.drain(term);

			// Each cycle re-opens a tall transient prompt and collapses it. A
			// monotonic windowTop accumulates the drift every cycle, so the
			// editor must be re-anchored each time, not only the first.
			for (let cycle = 0; cycle < 3; cycle++) {
				editor.lines = [...rows(`prompt${cycle}-`, 5), "> "];
				tui.requestRender();
				await scheduler.drain(term);

				editor.lines = ["> "];
				tui.requestRender();
				await scheduler.drain(term);

				const view = viewportText(term);
				const editorRow = view.indexOf(">");
				expect(editorRow).toBeGreaterThanOrEqual(0);
				const blanksBelow = view.length - 1 - editorRow;
				expect(blanksBelow).toBeLessThanOrEqual(1);
			}
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});
