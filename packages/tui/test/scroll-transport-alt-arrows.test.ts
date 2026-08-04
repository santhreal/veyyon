/**
 * The `"alt-arrows"` scroll transport: scroll the transcript without ever
 * grabbing the mouse.
 *
 * WHY THIS SUITE EXISTS. Scroll isolation pins the composer by holding mouse
 * reporting (`1000h`+`1006h`), and that grab is precisely what takes native
 * drag-select away from the terminal — selection becomes Shift+drag for the rest
 * of the session, and an operator reads that as copy being broken. `tui.ts`
 * records the reasoning and its conclusion that "there is no mode that reports
 * the wheel without the buttons, so the two cannot both be live". That holds on
 * the normal screen and fails on the alternate one: xterm's Alternate Scroll Mode
 * (DECSET 1007) makes the terminal translate wheel ticks into cursor-up/down KEYS
 * while the alt buffer is displayed, so an application scrolls its own viewport
 * with no mouse reporting at all. That is how a pinned composer and ordinary text
 * selection coexist.
 *
 * The price is that a synthesized wheel arrow is byte-identical to a typed one,
 * so the engine cannot classify it; the host decides and calls `scrollByRows`,
 * which is why these cases drive that entry point rather than feeding key bytes.
 *
 * Byte assertions, not behavioural ones, for the tracking half: the damage to
 * selection is done by the enable sequence itself, so a transport that merely
 * declined to ACT on wheel reports while still enabling tracking would pass every
 * behavioural test and still break selection.
 */

import { describe, expect, it } from "bun:test";
import { type Component, CURSOR_MARKER, type Focusable, TUI } from "@veyyon/tui";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

/** Records every byte the engine writes, then feeds the real VT engine. */
class RecordingTerminal extends VirtualTerminal {
	written: string[] = [];
	override write(data: string): void {
		this.written.push(data);
		super.write(data);
	}
	/** Everything the engine has emitted this run, as one string. */
	output(): string {
		return this.written.join("");
	}
	/** Everything emitted since `mark` bytes were recorded. */
	outputSince(mark: number): string {
		return this.written.slice(mark).join("");
	}
	mark(): number {
		return this.written.length;
	}
}

class Body implements Component {
	rows: string[] = [];
	invalidate(): void {}
	render(): readonly string[] {
		return this.rows;
	}
}

class Composer implements Component, Focusable {
	focused = false;
	invalidate(): void {}
	setUseTerminalCursor(): void {}
	handleInput(): void {}
	render(): readonly string[] {
		return [`>${CURSOR_MARKER}`];
	}
}

/** The mouse-tracking enable bytes whose ABSENCE is this transport's purpose. */
const TRACKING_ENABLE_BUTTONS = "\x1b[?1000h";
const ALT_SCROLL_ON = "\x1b[?1007h";
const ALT_SCROLL_OFF = "\x1b[?1007l";

interface Rig {
	term: RecordingTerminal;
	tui: TUI;
	scheduler: StressRenderScheduler;
}

/**
 * A session with far more history than fits the viewport, which is what arms the
 * scroll gate. Anything less and there would be nothing above the window, so an
 * assertion about tracking bytes could pass for the wrong reason.
 */
async function rig(): Promise<Rig> {
	const term = new RecordingTerminal(30, 8, 5_000);
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(term, true, { renderScheduler: scheduler });
	const body = new Body();
	const composer = new Composer();
	body.rows = Array.from({ length: 40 }, (_, i) => `h${i}`);
	tui.addChild(body);
	tui.addChild(composer);
	tui.setFocus(composer);
	tui.setPinnedFooterChildCount(1);
	tui.setScrollbackRebuild(false); // env-derived default, stated
	tui.start();
	await scheduler.drain(term);
	return { term, tui, scheduler };
}

describe("alt-arrows scroll transport", () => {
	/**
	 * The transport's whole reason for existing. Isolation is on with enough
	 * history to scroll, and no mouse-tracking enable byte is ever written, so the
	 * terminal keeps native selection.
	 */
	it("never enables mouse tracking", async () => {
		const { term, tui, scheduler } = await rig();
		try {
			tui.setScrollTransport("alt-arrows");
			tui.setScrollIsolation(true);
			await scheduler.drain(term);

			expect(tui.scrollTransport).toBe("alt-arrows");
			expect(term.output()).not.toContain(TRACKING_ENABLE_BUTTONS);
		} finally {
			tui.stop();
		}
	});

	/**
	 * The differential against the mouse transport, on identical content: the same
	 * rig with the shipped transport DOES enable tracking. Without this the case
	 * above would also pass for a TUI that simply never scrolled.
	 */
	it("differs from the mouse transport, which does enable tracking", async () => {
		const { term, tui, scheduler } = await rig();
		try {
			tui.setScrollIsolation(true);
			await scheduler.drain(term);

			expect(tui.scrollTransport).toBe("mouse");
			expect(term.output()).toContain(TRACKING_ENABLE_BUTTONS);
		} finally {
			tui.stop();
		}
	});

	/**
	 * Alternate Scroll Mode has to be SET, not assumed: xterm ships the
	 * `alternateScroll` resource defaulting to false, so a transport relying on the
	 * terminal's default would find the wheel silently dead on stock xterm.
	 */
	it("sets alternate scroll mode when the transport engages", async () => {
		const { term, tui, scheduler } = await rig();
		try {
			tui.setScrollIsolation(true);
			tui.setScrollTransport("alt-arrows");
			await scheduler.drain(term);

			expect(term.output()).toContain(ALT_SCROLL_ON);
		} finally {
			tui.stop();
		}
	});

	/**
	 * The mode is a terminal-level flag, not a per-buffer one, so leaving it set on
	 * exit would hand the operator's next full-screen program a wheel that types
	 * arrow keys. Asserted on `stop()`, the path every exit takes.
	 */
	it("clears alternate scroll mode on stop", async () => {
		const { term, tui, scheduler } = await rig();
		tui.setScrollIsolation(true);
		tui.setScrollTransport("alt-arrows");
		await scheduler.drain(term);
		const mark = term.mark();

		tui.stop();

		expect(term.outputSince(mark)).toContain(ALT_SCROLL_OFF);
	});

	/**
	 * Switching back mid-session clears it too, or a session that toggled the
	 * setting would leave both transports half-armed: alternate scroll still set
	 * while the mouse grab is also live.
	 */
	it("clears alternate scroll mode when switching back to the mouse transport", async () => {
		const { term, tui, scheduler } = await rig();
		try {
			tui.setScrollIsolation(true);
			tui.setScrollTransport("alt-arrows");
			await scheduler.drain(term);
			const mark = term.mark();

			tui.setScrollTransport("mouse");
			await scheduler.drain(term);

			expect(term.outputSince(mark)).toContain(ALT_SCROLL_OFF);
		} finally {
			tui.stop();
		}
	});

	/**
	 * The host-classified gesture reaches the same frozen-region view the wheel
	 * drives, moving by the rows it was handed rather than a wheel step. One owner
	 * for the movement is what keeps the two transports from disagreeing about
	 * where the view may stop.
	 */
	it("scrolls the transcript by the rows the host routes", async () => {
		const { term, tui, scheduler } = await rig();
		try {
			tui.setScrollIsolation(true);
			tui.setScrollTransport("alt-arrows");
			await scheduler.drain(term);

			expect(tui.scrollByRows(-3)).toBe(true);
			await scheduler.drain(term);

			expect(tui.virtualScrollActive).toBe(true);
			expect(tui.virtualScrollNewRows).toBe(3);
		} finally {
			tui.stop();
		}
	});

	/**
	 * A gesture that changes nothing reports false, which is what lets a host that
	 * mis-classified a typed arrow as a wheel tick fall back to ordinary key
	 * handling instead of swallowing the keypress. Scrolling toward the tail while
	 * already following it is exactly that case.
	 */
	it("reports an unconsumed gesture when there is nothing to scroll", async () => {
		const { term, tui, scheduler } = await rig();
		try {
			tui.setScrollIsolation(true);
			tui.setScrollTransport("alt-arrows");
			await scheduler.drain(term);

			expect(tui.scrollByRows(3)).toBe(false);
			expect(tui.virtualScrollActive).toBe(false);
		} finally {
			tui.stop();
		}
	});

	/**
	 * Routing a scroll while isolation is off must not freeze a view. The setting
	 * is the operator's off switch for the whole model, and a host that kept
	 * classifying arrows would otherwise scroll a transcript they asked to leave
	 * alone.
	 */
	it("ignores routed scrolls while isolation is off", async () => {
		const { term, tui, scheduler } = await rig();
		try {
			tui.setScrollTransport("alt-arrows");
			await scheduler.drain(term);

			expect(tui.scrollByRows(-3)).toBe(false);
			expect(tui.virtualScrollActive).toBe(false);
		} finally {
			tui.stop();
		}
	});
});
