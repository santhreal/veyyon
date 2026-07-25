import { describe, expect, it } from "bun:test";
import { type Component, CURSOR_MARKER, type Focusable, TUI } from "@veyyon/tui";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

// Scroll isolation (2026-07-22 operator requirement): the wheel scrolls the
// transcript region while the pinned footer (composer zone) stays live at the
// viewport bottom — the opencode/grok-build model. Without it the terminal's
// native scrollback scrolls the whole window, composer included, so the
// prompt leaves the screen exactly when the operator is reading history.

class Transcript implements Component {
	lines: string[] = [];

	invalidate(): void {}

	render(_width: number): readonly string[] {
		return this.lines;
	}
}

class Editor implements Component, Focusable {
	focused = false;
	text = ">";
	received: string[] = [];

	invalidate(): void {}

	setUseTerminalCursor(): void {}

	handleInput(data: string): void {
		this.received.push(data);
		this.text = `> ${data}`;
	}

	render(_width: number): readonly string[] {
		return [this.text + CURSOR_MARKER];
	}
}

function rows(prefix: string, n: number): string[] {
	return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

const WHEEL_UP = "\x1b[<64;5;5M";
const WHEEL_DOWN = "\x1b[<65;5;5M";

interface Rig {
	term: VirtualTerminal;
	tui: TUI;
	scheduler: StressRenderScheduler;
	transcript: Transcript;
	editor: Editor;
}

async function setup(transcriptRows: number, height = 10): Promise<Rig> {
	const term = new VirtualTerminal(40, height, 1_000);
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(term, true, { renderScheduler: scheduler });
	// Shipped default, stated rather than inherited: the constructor reads
	// VEYYON_TUI_SCROLLBACK_REBUILD, and another suite in this process sets it at
	// module scope, which would otherwise decide this suite's behaviour.
	tui.setScrollbackRebuild(false);
	const transcript = new Transcript();
	const editor = new Editor();
	tui.addChild(transcript);
	tui.addChild(editor);
	tui.setFocus(editor);
	tui.setScrollIsolation(true);
	tui.setPinnedFooterChildCount(1);
	transcript.lines = rows("hist-", transcriptRows);
	tui.start();
	await scheduler.drain(term);
	return { term, tui, scheduler, transcript, editor };
}

function viewportText(term: VirtualTerminal): string[] {
	return term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
}

/**
 * Viewport rows with the last column dropped. A frozen transcript region draws
 * the scroll position in that column, so a case about CONTENT reads it here and
 * the track's own bytes are asserted in "draws the scroll position on the right
 * edge of the frozen region" below. Dropping the column by width (never by
 * matching the glyph) keeps content that legitimately ends in a box character
 * from being trimmed as if it were chrome.
 */
function contentText(term: VirtualTerminal, width = 40): string[] {
	return term.getViewport().map(row => Bun.stripANSI(row).padEnd(width, " ").slice(0, width - 1).trimEnd());
}

describe("scroll isolation", () => {
	it("freezes the transcript region on wheel up while the footer stays pinned at the bottom", async () => {
		// The core contract: wheel-up moves the transcript slice up by the
		// wheel step, and the footer row stays live at the viewport bottom.
		const { term, tui, scheduler } = await setup(30);
		try {
			// Frame is 31 rows in a 10-row viewport: the live tail top is 21.
			expect(viewportText(term)[9]).toBe(">");
			term.sendInput(WHEEL_UP);
			await scheduler.drain(term);

			expect(tui.virtualScrollActive).toBe(true);
			const view = contentText(term);
			expect(view[0]).toBe("hist-18"); // 21 - 3 (one wheel step)
			expect(view[8]).toBe("hist-26");
			expect(viewportText(term)[9]).toBe(">"); // footer never moved, track-free
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("keeps the footer live while the transcript view is frozen", async () => {
		// Typing while scrolled up must repaint in the footer: the frozen
		// region covers the transcript only, the composer never freezes.
		const { term, tui, scheduler, editor } = await setup(30);
		try {
			term.sendInput(WHEEL_UP);
			await scheduler.drain(term);
			editor.text = "> draft";
			tui.requestRender();
			await scheduler.drain(term);

			expect(contentText(term)[0]).toBe("hist-18"); // transcript still frozen
			expect(viewportText(term)[9]).toBe("> draft"); // footer live and track-free
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("freezes commits while scrolled and backfills exactly once on resume", async () => {
		// Streaming while the operator reads history: new rows must not disturb
		// the frozen view and must not enter native scrollback (a chunk's
		// scroll would tear the view). On resume the held rows commit once,
		// never twice — duplication is only accepted for collapse re-anchors.
		const { term, tui, scheduler, transcript } = await setup(30);
		try {
			term.sendInput(WHEEL_UP);
			await scheduler.drain(term);

			// Five new rows stream in behind the frozen view.
			transcript.lines = rows("hist-", 35);
			tui.requestRender();
			await scheduler.drain(term);

			expect(contentText(term)[0]).toBe("hist-18"); // view untouched by the stream
			expect(tui.virtualScrollNewRows).toBe(8); // 3 scrolled + 5 streamed
			expect(term.getScrollBuffer().join("\n")).not.toContain("hist-34");

			// Walk back down to the tail: three more steps resume following.
			for (let i = 0; i < 4; i++) {
				term.sendInput(WHEEL_DOWN);
				await scheduler.drain(term);
			}
			expect(tui.virtualScrollActive).toBe(false);
			const view = viewportText(term);
			expect(view[0]).toBe("hist-26"); // live tail of the 36-row frame
			expect(view[9]).toBe(">");

			// Backfill committed the held rows exactly once.
			const buffer = term.getScrollBuffer().join("\n");
			expect(buffer.split("hist-20").length - 1).toBe(1);
			expect(buffer).toContain("hist-25");
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("resumes following on scrollToLiveTail (the host's submit hook)", async () => {
		// Chat idiom: submitting a message snaps back to the live tail.
		const { term, tui, scheduler } = await setup(30);
		try {
			term.sendInput(WHEEL_UP);
			await scheduler.drain(term);
			expect(tui.virtualScrollActive).toBe(true);

			tui.scrollToLiveTail();
			await scheduler.drain(term);
			expect(tui.virtualScrollActive).toBe(false);
			const view = viewportText(term);
			expect(view[0]).toBe("hist-21");
			expect(view[9]).toBe(">");
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("resumes following on resize instead of compositing a stale slice", async () => {
		// A geometry change rewraps every row; the frozen slice is meaningless
		// at the new width, so the view returns to the live tail.
		const { term, tui, scheduler } = await setup(30);
		try {
			term.sendInput(WHEEL_UP);
			await scheduler.drain(term);
			expect(tui.virtualScrollActive).toBe(true);

			term.resize(40, 12);
			await scheduler.drain(term);
			expect(tui.virtualScrollActive).toBe(false);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("accelerates repeated same-direction wheel ticks and resets after a pause", async () => {
		// The opencode scrollbox lesson: flying through a long transcript must
		// not cost one flick per screen. Three rapid ticks step 3, 6, 9 rows
		// (streak multiplier); a pause longer than the accel window resets the
		// streak to the base step.
		const { term, tui, scheduler } = await setup(60);
		try {
			// Live tail top is 51 (61-row frame in a 10-row viewport).
			term.sendInput(WHEEL_UP); // 51 -> 48
			await scheduler.drain(term);
			term.sendInput(WHEEL_UP); // streak 1: 48 -> 42
			await scheduler.drain(term);
			term.sendInput(WHEEL_UP); // streak 2: 42 -> 33
			await scheduler.drain(term);
			expect(contentText(term)[0]).toBe("hist-33");

			// After the accel window lapses, the next tick is the base step again.
			scheduler.advance(400);
			term.sendInput(WHEEL_UP); // 33 -> 30
			await scheduler.drain(term);
			expect(contentText(term)[0]).toBe("hist-30");
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("resumes following when the pinned footer is clicked", async () => {
		// The operator's ask (2026-07-23): the scroll indicator says "click to
		// go to the bottom" — a left click anywhere in the pinned footer (band
		// or composer) snaps back to the live tail. Clicks in the frozen
		// transcript region do NOT resume (that region is for reading).
		const { term, tui, scheduler } = await setup(30);
		try {
			term.sendInput(WHEEL_UP);
			await scheduler.drain(term);
			expect(tui.virtualScrollActive).toBe(true);

			// Click in the transcript region: still frozen.
			term.sendInput("\x1b[<0;10;3M");
			await scheduler.drain(term);
			expect(tui.virtualScrollActive).toBe(true);

			// Click in the footer (last row): resumes.
			term.sendInput("\x1b[<0;10;10M");
			await scheduler.drain(term);
			expect(tui.virtualScrollActive).toBe(false);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("never leaks raw SGR mouse bytes into the focused component", async () => {
		// With tracking on, clicks and wheel reports are engine input, not
		// text: a stray report reaching the editor would insert escape junk.
		const { term, tui, scheduler, editor } = await setup(30);
		try {
			term.sendInput(WHEEL_UP);
			term.sendInput("\x1b[<0;12;4M"); // left click
			await scheduler.drain(term);
			expect(editor.received).toEqual([]);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("keeps wheel tracking armed once rows have scrolled off, and tears it down on stop", async () => {
		// The mode contract: 1000h+1006h while anything sits above the window
		// (never 1003h, which would flood input with motion events), and fully
		// reset on stop. Gating on the composed frame overflowing the viewport
		// was the bug: the frame shrinking back does NOT mean the session has
		// nothing to scroll, because the rows that left the frame are on the
		// tape, and releasing the mouse there handed the wheel to the terminal,
		// which scrolled the pinned composer off screen.
		const term = new VirtualTerminal(40, 10, 1_000);
		const originalWrite = term.write.bind(term);
		let written = "";
		term.write = (data: string) => {
			written += data;
			originalWrite(data);
		};
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		tui.setScrollbackRebuild(false); // see setup(): the default is env-derived
		const transcript = new Transcript();
		transcript.lines = rows("hist-", 30);
		tui.addChild(transcript);
		tui.setScrollIsolation(true);
		tui.start();
		await scheduler.drain(term);
		expect(written).toContain("\x1b[?1000h\x1b[?1006h");
		expect(written).not.toContain("\x1b[?1003h");
		expect(tui.scrollTapeRows).toBeGreaterThan(0);

		// Shrink below the viewport. History is on the tape, so there is still
		// something above the window and the mouse is NOT released.
		written = "";
		transcript.lines = rows("hist-", 5);
		tui.requestRender();
		await scheduler.drain(term);
		expect(written).not.toContain("\x1b[?1006l\x1b[?1000l");

		// And the wheel still reaches the engine rather than the terminal.
		term.sendInput(WHEEL_UP);
		await scheduler.drain(term);
		expect(tui.virtualScrollActive).toBe(true);

		tui.stop();
		expect(written).toContain("\x1b[?1006l\x1b[?1000l");
		await term.flush();
	});

	it("never captures the mouse before anything has scrolled off", async () => {
		// The selection-preservation contract: with nothing above the window at
		// all — a short frame in a fresh session, nothing on the tape — there is
		// no reason to hold the mouse, so no tracking bytes are emitted and
		// plain drag-select keeps working.
		const term = new VirtualTerminal(40, 10, 1_000);
		const originalWrite = term.write.bind(term);
		let written = "";
		term.write = (data: string) => {
			written += data;
			originalWrite(data);
		};
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		tui.setScrollbackRebuild(false); // see setup(): the default is env-derived
		const transcript = new Transcript();
		transcript.lines = rows("hist-", 5);
		tui.addChild(transcript);
		tui.setScrollIsolation(true);
		tui.start();
		await scheduler.drain(term);
		expect(written).not.toContain("\x1b[?1000h");
		expect(written).not.toContain("\x1b[?1002h");
		expect(written).not.toContain("\x1b[?1003h");
		tui.stop();
		await term.flush();
	});
});
