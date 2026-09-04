import { describe, expect, it } from "bun:test";
import { type Component, CURSOR_MARKER, type Focusable, TUI } from "@veyyon/tui";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

/**
 * Reporting a drag the engine ate (`TUI#onSelectionAttempt`).
 *
 * Scroll isolation holds the mouse so the wheel can scroll the transcript with
 * the prompt pinned, and holding it also takes plain drag-select away from the
 * terminal (shift+drag is the terminal-side override). Before this hook the
 * gesture vanished with no feedback whatsoever, and the operator concluded copy
 * was broken: "i cant copy and paste from the terminal" (2026-07-24). Tracking
 * mode is 1000h — press and release only, no motion reports — so a press paired
 * with a release in a different cell is the only evidence a drag happened, and
 * the release is the one chance to see it.
 *
 * These cases pin WHICH gestures count, because both mistakes are bad: a hook
 * that misses the drag leaves the operator stuck, and one that fires on every
 * ordinary click turns a hint into noise.
 */

const WIDTH = 30;
const HEIGHT = 8;
const WHEEL_UP = "\x1b[<64;5;5M";

/** SGR press/release reports. Wire coordinates are 1-based; rows/cols here are 0-based. */
const press = (row: number, col: number) => `\x1b[<0;${col + 1};${row + 1}M`;
const release = (row: number, col: number) => `\x1b[<0;${col + 1};${row + 1}m`;

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

interface Rig {
	term: VirtualTerminal;
	tui: TUI;
	scheduler: StressRenderScheduler;
	attempts: number;
	count: () => number;
}

/** A session tall enough to scroll, with the hook counting attempts. */
async function rig(): Promise<Rig> {
	const term = new VirtualTerminal(WIDTH, HEIGHT, 5_000);
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(term, true, { renderScheduler: scheduler });
	const body = new Body();
	const composer = new Composer();
	body.rows = Array.from({ length: 40 }, (_, i) => `h${i}`);
	tui.addChild(body);
	tui.addChild(composer);
	tui.setFocus(composer);
	tui.setScrollIsolation(true);
	tui.setPinnedFooterChildCount(1);
	tui.setScrollbackRebuild(false); // env-derived default, stated
	let attempts = 0;
	tui.onSelectionAttempt = () => {
		attempts++;
	};
	tui.start();
	await scheduler.drain(term);
	return { term, tui, scheduler, attempts, count: () => attempts };
}

describe("a drag the engine swallowed is reported to the host", () => {
	it("fires when the release lands in a different cell than the press", async () => {
		// The gesture the operator made: press on one word, drag across, let go.
		const { term, tui, scheduler, count } = await rig();
		try {
			expect(tui.scrollIsolation).toBe(true);
			term.sendInput(press(2, 4));
			term.sendInput(release(2, 17));
			await scheduler.drain(term);
			expect(count()).toBe(1);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("fires for a drag that spans rows, not only columns", async () => {
		// Selecting several lines is the common case, and the row is the axis that
		// changes; a column-only comparison would miss it entirely.
		const { term, tui, scheduler, count } = await rig();
		try {
			term.sendInput(press(1, 6));
			term.sendInput(release(4, 6));
			await scheduler.drain(term);
			expect(count()).toBe(1);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("stays silent for a plain click, which selected nothing to begin with", async () => {
		// Press and release in the same cell is a click. Nothing was lost, so
		// there is nothing to explain, and a notice here would fire constantly.
		const { term, tui, scheduler, count } = await rig();
		try {
			term.sendInput(press(3, 9));
			term.sendInput(release(3, 9));
			await scheduler.drain(term);
			expect(count()).toBe(0);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("stays silent for a drag that starts in the pinned footer", async () => {
		// The footer is chrome the engine owns: a press there is a click target
		// (it snaps back to the live tail), never an attempt to select transcript.
		const { term, tui, scheduler, count } = await rig();
		try {
			const footerRow = HEIGHT - 1;
			term.sendInput(press(footerRow, 2));
			term.sendInput(release(footerRow, 12));
			await scheduler.drain(term);
			expect(count()).toBe(0);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("stays silent for wheel reports, including a wheel between press and release", async () => {
		// The wheel is the gesture isolation exists to serve. It also must not
		// leave a stale press behind that pairs with a later unrelated release.
		const { term, tui, scheduler, count } = await rig();
		try {
			term.sendInput(WHEEL_UP);
			await scheduler.drain(term);
			expect(count()).toBe(0);
			// And the wheel was in fact captured, so these cases run against a held
			// mouse rather than a terminal that never reported anything.
			expect(tui.virtualScrollActive).toBe(true);

			term.sendInput(press(2, 3));
			term.sendInput(WHEEL_UP);
			term.sendInput(release(5, 20));
			await scheduler.drain(term);
			expect(count()).toBe(0);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("reports every drag, leaving 'tell them once' to the host", async () => {
		// The engine keeps no "already explained" state: a host that wants to
		// speak once owns that decision, and a host that wants a status line on
		// each attempt can have one. Two drags, two reports.
		const { term, tui, scheduler, count } = await rig();
		try {
			term.sendInput(press(2, 4));
			term.sendInput(release(2, 15));
			term.sendInput(press(3, 4));
			term.sendInput(release(3, 15));
			await scheduler.drain(term);
			expect(count()).toBe(2);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("does not report while isolation is off, when the terminal owns selection", async () => {
		// With isolation off the mouse is never held, drag-select works natively,
		// and the engine sees no reports at all — so a notice would be a lie.
		const { term, tui, scheduler, count } = await rig();
		try {
			tui.setScrollIsolation(false);
			await scheduler.drain(term);
			term.sendInput(press(2, 4));
			term.sendInput(release(2, 15));
			await scheduler.drain(term);
			expect(count()).toBe(0);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});
