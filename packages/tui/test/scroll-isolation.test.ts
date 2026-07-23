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
			const view = viewportText(term);
			expect(view[0]).toBe("hist-18"); // 21 - 3 (one wheel step)
			expect(view[8]).toBe("hist-26");
			expect(view[9]).toBe(">"); // footer never moved
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

			const view = viewportText(term);
			expect(view[0]).toBe("hist-18"); // transcript still frozen
			expect(view[9]).toBe("> draft"); // footer live
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

			let view = viewportText(term);
			expect(view[0]).toBe("hist-18"); // view untouched by the stream
			expect(tui.virtualScrollNewRows).toBe(8); // 3 scrolled + 5 streamed
			expect(term.getScrollBuffer().join("\n")).not.toContain("hist-34");

			// Walk back down to the tail: three more steps resume following.
			for (let i = 0; i < 4; i++) {
				term.sendInput(WHEEL_DOWN);
				await scheduler.drain(term);
			}
			expect(tui.virtualScrollActive).toBe(false);
			view = viewportText(term);
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

	it("writes wheel tracking modes only while the frame overflows, and tears them down on stop", async () => {
		// The mode contract: 1000h+1006h while a scrollable frame runs (never
		// 1003h, which would flood input with motion events), released when the
		// frame fits the viewport so short screens keep native drag-select,
		// and fully reset on stop.
		const term = new VirtualTerminal(40, 10, 1_000);
		const originalWrite = term.write.bind(term);
		let written = "";
		term.write = (data: string) => {
			written += data;
			originalWrite(data);
		};
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		const transcript = new Transcript();
		transcript.lines = rows("hist-", 30);
		tui.addChild(transcript);
		tui.setScrollIsolation(true);
		tui.start();
		await scheduler.drain(term);
		expect(written).toContain("\x1b[?1000h\x1b[?1006h");
		expect(written).not.toContain("\x1b[?1003h");

		// Shrink below the viewport: tracking releases mid-session.
		written = "";
		transcript.lines = rows("hist-", 5);
		tui.requestRender();
		await scheduler.drain(term);
		expect(written).toContain("\x1b[?1006l\x1b[?1000l");

		// Grow back: tracking re-arms.
		written = "";
		transcript.lines = rows("hist-", 30);
		tui.requestRender();
		await scheduler.drain(term);
		expect(written).toContain("\x1b[?1000h\x1b[?1006h");

		tui.stop();
		expect(written).toContain("\x1b[?1006l\x1b[?1000l");
		await term.flush();
	});

	it("never captures the mouse on a frame that fits the viewport", async () => {
		// The selection-preservation contract: with nothing to scroll there is
		// no reason to hold the mouse, so a short frame emits no tracking
		// bytes at all and plain drag-select keeps working.
		const term = new VirtualTerminal(40, 10, 1_000);
		const originalWrite = term.write.bind(term);
		let written = "";
		term.write = (data: string) => {
			written += data;
			originalWrite(data);
		};
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, true, { renderScheduler: scheduler });
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
