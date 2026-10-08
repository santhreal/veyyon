import { describe, expect, it } from "bun:test";
import {
	type Component,
	CURSOR_MARKER,
	type Focusable,
	type NativeScrollbackCommittedRows,
	type NativeScrollbackCompaction,
	type NativeScrollbackReplay,
	TUI,
} from "@veyyon/tui";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

/**
 * The scroll tape holds painted rows only while scroll isolation reads them.
 *
 * THE DEFECT. The engine appended every row that scrolled off the window to its scroll tape, up to
 * 20,000 prepared rows, whether or not anything would read them. Only scroll isolation reads the
 * tape back; with it off (the default) the terminal's own scrollback holds the history, and the tape
 * was a second copy of it held for the life of the session.
 *
 * THE CLASS. Every way a row reaches the tape: the rows a frame scrolls off, and the history replay
 * that turning isolation on mid-session starts, since nothing recorded the rows that scrolled off
 * before. The count of rows handed to scrollback, which the wheel capture reads, keeps counting with
 * the tape off.
 *
 * WHAT IT DOES NOT CATCH. The alternate-screen transport's exit replay, which reads the tape after
 * isolation turns off; `scroll-isolation-history.test.ts` drives the tape with isolation on.
 */

const WIDTH = 40;
const HEIGHT = 10;
const WHEEL_UP = "\x1b[<64;5;5M";

/**
 * A transcript that drops committed rows from its frame, as `TranscriptContainer` does, and renders
 * every row in the frame that follows a replay request, as its `#replayPending` render does.
 */
class VirtualizedTranscript
	implements Component, NativeScrollbackCommittedRows, NativeScrollbackCompaction, NativeScrollbackReplay
{
	all: string[] = [];
	dropped = 0;
	#committed = 0;
	#replaying = false;
	#reported = 0;

	invalidate(): void {}

	setNativeScrollbackCommittedRows(rows: number): void {
		this.#committed = rows;
	}

	takeNativeScrollbackDroppedRows(): number {
		const dropped = this.#reported;
		this.#reported = 0;
		return dropped;
	}

	prepareNativeScrollbackReplay(): void {
		this.dropped = 0;
		this.#reported = 0;
		this.#replaying = true;
	}

	render(_width: number): readonly string[] {
		if (this.#replaying) {
			this.#replaying = false;
		} else if (this.#committed > 0) {
			this.dropped += this.#committed;
			this.#reported += this.#committed;
			this.#committed = 0;
		}
		return this.all.slice(this.dropped);
	}
}

class Composer implements Component, Focusable {
	focused = false;

	invalidate(): void {}

	setUseTerminalCursor(): void {}

	handleInput(): void {}

	render(_width: number): readonly string[] {
		return [`>${CURSOR_MARKER}`];
	}
}

interface Rig {
	term: VirtualTerminal;
	tui: TUI;
	scheduler: StressRenderScheduler;
	transcript: VirtualizedTranscript;
}

async function session(isolation: boolean): Promise<Rig> {
	const term = new VirtualTerminal(WIDTH, HEIGHT, 5_000);
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(term, true, { renderScheduler: scheduler });
	const transcript = new VirtualizedTranscript();
	const composer = new Composer();
	tui.addChild(transcript);
	tui.addChild(composer);
	tui.setFocus(composer);
	tui.setScrollIsolation(isolation);
	tui.setPinnedFooterChildCount(1);
	tui.setScrollbackRebuild(false);
	transcript.all = rows(0, 8);
	tui.start();
	await scheduler.drain(term);
	return { term, tui, scheduler, transcript };
}

/** Stream `steps` rounds of five rows, each round drawn in its own frame. */
async function stream({ tui, term, scheduler, transcript }: Rig, steps: number): Promise<void> {
	for (let i = 0; i < steps; i++) {
		transcript.all = [...transcript.all, ...rows(transcript.all.length, 5)];
		tui.requestRender();
		await scheduler.drain(term);
	}
}

function rows(from: number, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `h${from + i}`);
}

/** Rows above the window: every transcript row plus the one-row composer, less one screen. */
function scrolledOff({ transcript }: Rig): number {
	return transcript.all.length + 1 - HEIGHT;
}

/** A painted row with styling and the scroll-track column dropped. */
function plain(row: string): string {
	return Bun.stripANSI(row)
		.padEnd(WIDTH, " ")
		.slice(0, WIDTH - 1)
		.trimEnd();
}

function viewport(term: VirtualTerminal): string[] {
	return term.getViewport().map(plain);
}

/** The terminal's own scrollback, above the viewport. */
function scrollback(term: VirtualTerminal): string[] {
	return term.getScrollBuffer().map(plain);
}

async function stop({ tui, term }: Rig): Promise<void> {
	tui.stop();
	await term.flush();
}

describe("the scroll tape", () => {
	it("keeps no row while scroll isolation is off, and counts every row that scrolled off", async () => {
		const rig = await session(false);
		try {
			await stream(rig, 12);
			expect(rig.tui.scrollTapeRows).toBe(0);
			expect(rig.tui.scrolledOffRows).toBe(scrolledOff(rig));
			// The terminal's own scrollback holds the history the tape did not copy.
			expect(scrollback(rig.term)).toContain("h0");
		} finally {
			await stop(rig);
		}
	});

	it("records the whole history when isolation turns on mid-session, and the wheel reaches its first row", async () => {
		const rig = await session(false);
		try {
			await stream(rig, 12);
			rig.tui.setScrollIsolation(true);
			await rig.scheduler.drain(rig.term);
			expect(rig.tui.scrollTapeRows).toBe(scrolledOff(rig));
			// The replay rewrote the terminal's scrollback rather than appending a second copy below it.
			expect(rig.tui.scrolledOffRows).toBe(scrolledOff(rig));
			expect(scrollback(rig.term).filter(line => line === "h0")).toHaveLength(1);

			for (let tick = 0; tick < 40 && !viewport(rig.term).includes("h0"); tick++) {
				rig.term.sendInput(WHEEL_UP);
				await rig.scheduler.drain(rig.term);
			}
			expect(rig.tui.virtualScrollActive).toBe(true);
			expect(viewport(rig.term)).toContain("h0");
		} finally {
			await stop(rig);
		}
	});

	it("stops growing when isolation turns off, while the count goes on", async () => {
		const rig = await session(true);
		try {
			await stream(rig, 6);
			const kept = rig.tui.scrollTapeRows;
			expect(kept).toBeGreaterThan(0);
			rig.tui.setScrollIsolation(false);
			await rig.scheduler.drain(rig.term);
			const counted = rig.tui.scrolledOffRows;
			await stream(rig, 6);
			expect(rig.tui.scrollTapeRows).toBe(kept);
			expect(rig.tui.scrolledOffRows).toBe(counted + 30);
		} finally {
			await stop(rig);
		}
	});
});
