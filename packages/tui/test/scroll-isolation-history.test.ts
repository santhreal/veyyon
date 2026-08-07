import { describe, expect, it } from "bun:test";
import {
	type Component,
	CURSOR_MARKER,
	type Focusable,
	type NativeScrollbackCommittedRows,
	type NativeScrollbackReplay,
	TUI,
} from "@veyyon/tui";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

/**
 * Scroll isolation over a VIRTUALIZED transcript — the shape the coding agent
 * actually runs, and the case the original suite could not see.
 *
 * `scroll-isolation.test.ts` drives a transcript that returns its whole history
 * every frame, so its composed frame grows without bound and the wheel always
 * had something to scroll. The real `TranscriptContainer` hands committed rows
 * to native scrollback and then DROPS them from its own render output
 * (`#compactCommittedPrefix`), which holds the frame near the viewport height
 * however long the session runs. Under that shape the old engine released the
 * mouse on quiet frames, the wheel went to the terminal, and the pinned
 * composer scrolled off screen. Every case here fails against that engine.
 */

const WIDTH = 40;
const HEIGHT = 10;
const WHEEL_UP = "\x1b[<64;5;5M";
const WHEEL_DOWN = "\x1b[<65;5;5M";

/**
 * A transcript that drops committed rows from its frame, mirroring
 * `TranscriptContainer`: the engine reports how many of the child's rows are in
 * native scrollback, and the child stops rendering them.
 */
class VirtualizedTranscript implements Component, NativeScrollbackCommittedRows, NativeScrollbackReplay {
	all: string[] = [];
	dropped = 0;
	replays = 0;
	#committed = 0;

	invalidate(): void {}

	setNativeScrollbackCommittedRows(rows: number): void {
		this.#committed = rows;
	}

	prepareNativeScrollbackReplay(): void {
		this.replays++;
		this.dropped = 0;
	}

	render(_width: number): readonly string[] {
		if (this.#committed > 0) {
			this.dropped += this.#committed;
			this.#committed = 0;
		}
		return this.all.slice(this.dropped);
	}
}

/** A one-row composer zone: the pinned footer, with a live cursor. */
class Composer implements Component, Focusable {
	focused = false;
	text = ">";

	invalidate(): void {}

	setUseTerminalCursor(): void {}

	handleInput(data: string): void {
		this.text = `> ${data}`;
	}

	render(_width: number): readonly string[] {
		return [this.text + CURSOR_MARKER];
	}
}

interface Rig {
	term: VirtualTerminal;
	tui: TUI;
	scheduler: StressRenderScheduler;
	transcript: VirtualizedTranscript;
	composer: Composer;
}

/** A session whose history has already scrolled off and been dropped: `steps`
 * rounds of five new rows each, exactly the streaming shape that empties the
 * frame back down to the viewport. */
async function session(steps = 12, height = HEIGHT): Promise<Rig> {
	const term = new VirtualTerminal(WIDTH, height, 5_000);
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(term, true, { renderScheduler: scheduler });
	const transcript = new VirtualizedTranscript();
	const composer = new Composer();
	tui.addChild(transcript);
	tui.addChild(composer);
	tui.setFocus(composer);
	tui.setScrollIsolation(true);
	tui.setPinnedFooterChildCount(1);
	// Rebuild OFF for this case: it is on by default, and these assertions are
	// about the append-below history the rebuild deliberately erases. The rebuild
	// is covered by its own case below.
	tui.setScrollbackRebuild(false);
	transcript.all = row(0, 8);
	tui.start();
	await scheduler.drain(term);
	for (let i = 0; i < steps; i++) {
		transcript.all = [...transcript.all, ...row(transcript.all.length, 5)];
		tui.requestRender();
		await scheduler.drain(term);
	}
	return { term, tui, scheduler, transcript, composer };
}

function row(from: number, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `h${from + i}`);
}

/** Viewport rows, styling stripped. */
function view(term: VirtualTerminal): string[] {
	return term.getViewport().map(r => Bun.stripANSI(r).trimEnd());
}

/** Viewport rows with the scroll-track column dropped, so a case about content
 * asserts content. The track's own bytes are asserted separately below. */
function content(term: VirtualTerminal): string[] {
	return term.getViewport().map(r =>
		Bun.stripANSI(r)
			.padEnd(WIDTH, " ")
			.slice(0, WIDTH - 1)
			.trimEnd(),
	);
}

/** The last column of each viewport row: the scroll track. */
function trackColumn(term: VirtualTerminal): string[] {
	return term.getViewport().map(r =>
		Bun.stripANSI(r)
			.padEnd(WIDTH, " ")
			.slice(WIDTH - 1),
	);
}

describe("scroll isolation over dropped history", () => {
	it("scrolls back into rows the transcript already dropped instead of doing nothing", async () => {
		// THE regression. The transcript has thrown away everything committed,
		// so the composed frame is about one screen tall and holds none of the
		// history the reader wants. Against the old engine ten wheel-ups left
		// virtualScrollActive false and the viewport unchanged, because the
		// mouse had been released and the terminal did the scrolling.
		const { term, tui, scheduler, transcript } = await session();
		try {
			expect(transcript.dropped).toBeGreaterThan(0); // history really left the frame
			const before = view(term);
			expect(before[9]).toBe(">"); // composer on the bottom row

			term.sendInput(WHEEL_UP);
			await scheduler.drain(term);

			expect(tui.virtualScrollActive).toBe(true);
			const after = content(term);
			expect(after[0]).not.toBe(before[0]); // the region moved
			expect(after[0]).toBe("h56"); // three rows above the previous top (h59)
			expect(view(term)[9]).toBe(">"); // and the composer did not move
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("walks back to the oldest row the tape still holds and stops there", async () => {
		// Scroll depth is the tape, not the commit lag: h0 is reachable. The old
		// engine could only ever reach `frameLength - height` rows back, which
		// with a virtualized transcript is a handful of rows.
		const { term, tui, scheduler } = await session();
		try {
			for (let i = 0; i < 80; i++) {
				term.sendInput(WHEEL_UP);
				await scheduler.drain(term);
			}
			expect(content(term)[0]).toBe("h0"); // the first row of the session
			expect(view(term)[9]).toBe(">"); // still pinned after 80 ticks

			// Pinned at the top: further wheel-ups change nothing and stay frozen.
			const atTop = content(term);
			term.sendInput(WHEEL_UP);
			await scheduler.drain(term);
			expect(content(term)).toEqual(atTop);
			expect(tui.virtualScrollActive).toBe(true);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("renders the composer zone byte-identically whether frozen or following", async () => {
		// The operator's second complaint: the prompt must not CHANGE either.
		// The footer is drawn from the live frame in both states, so its bytes
		// are equal — no scroll readout takes over a composer row.
		const { term, tui, scheduler } = await session();
		try {
			const following = term.getViewport()[9];
			term.sendInput(WHEEL_UP);
			await scheduler.drain(term);
			expect(tui.virtualScrollActive).toBe(true);
			expect(term.getViewport()[9]).toBe(following);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("keeps the frozen region still while the transcript keeps dropping rows underneath", async () => {
		// A quiet frame still compacts, so a view sourced from the live frame
		// would slide by five rows per repaint under a reader who scrolled once.
		// The snapshot is what makes the region hold.
		const { term, tui, scheduler } = await session();
		try {
			term.sendInput(WHEEL_UP);
			await scheduler.drain(term);
			const frozen = content(term).slice(0, 9);

			for (let i = 0; i < 3; i++) {
				tui.requestRender();
				await scheduler.drain(term);
			}
			expect(content(term).slice(0, 9)).toEqual(frozen);
			expect(tui.virtualScrollActive).toBe(true);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("keeps the composer live while the history above it is frozen", async () => {
		// Typing, spinners, and status updates keep repainting in the footer:
		// only the transcript region is frozen.
		const { term, tui, scheduler, composer } = await session();
		try {
			term.sendInput(WHEEL_UP);
			await scheduler.drain(term);
			const frozen = content(term)[0];

			composer.text = "> a draft";
			tui.requestRender();
			await scheduler.drain(term);

			expect(view(term)[9]).toBe("> a draft");
			expect(content(term)[0]).toBe(frozen);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("draws the scroll position on the right edge of the frozen region only", async () => {
		// The affordance lives in the region that moved. Exact geometry: a dim
		// groove down the transcript rows with a bright thumb, nothing in the
		// footer row, and nothing at all while following.
		const { term, tui, scheduler } = await session();
		const writes: string[] = [];
		const originalWrite = term.write.bind(term);
		term.write = (data: string) => {
			writes.push(data);
			originalWrite(data);
		};
		try {
			expect(trackColumn(term).join("")).toBe(" ".repeat(HEIGHT)); // following: no track

			for (let i = 0; i < 80; i++) {
				term.sendInput(WHEEL_UP); // all the way to the top
				await scheduler.drain(term);
			}
			let column = trackColumn(term);
			expect(column[9]).toBe(" "); // footer row is never touched
			expect(column[0]).toBe("█"); // at the top of the space, the thumb is at the top
			expect(column.slice(0, 9).join("")).toMatch(/^█+│+$/);
			// The groove is dimmed and the thumb is not: chrome recedes, position
			// reads. Asserted on the emitted bytes, because the harness
			// reconstructs viewport text without attributes.
			// The emitter merges the groove's dim attribute into the row's own SGR
			// run, so the painted bytes are "[0;2m│[22;0m"; the thumb carries no
			// dim at all. Asserted on the emit stream because the harness
			// reconstructs viewport text without attributes.
			const written = writes.join("");
			expect(written).toContain("\x1b[0;2m│\x1b[22;0m");
			expect(written).toContain("\x1b[0m█");
			expect(written).not.toContain("\x1b[0;2m█");
			// And the same claim on what the terminal PRESENTS, so a later reset in
			// the row cannot cancel the dim while the byte assertions still pass.
			const thumbRow = column.indexOf("█");
			const grooveRow = column.indexOf("│");
			expect(term.getViewportRowFaintColumns(grooveRow)).toContain(WIDTH - 1);
			expect(term.getViewportRowFaintColumns(thumbRow)).not.toContain(WIDTH - 1);

			// Walk back to the tail: the thumb ends at the bottom of the region.
			for (let i = 0; i < 80; i++) {
				term.sendInput(WHEEL_DOWN);
				await scheduler.drain(term);
			}
			expect(tui.virtualScrollActive).toBe(false);
			expect(trackColumn(term).join("")).toBe(" ".repeat(HEIGHT)); // gone again

			// One tick up: the thumb sits at the BOTTOM of the travel.
			term.sendInput(WHEEL_UP);
			await scheduler.drain(term);
			column = trackColumn(term);
			// Three rows back out of a 68-row space across 8 rows of travel: the
			// thumb is one row short of the bottom, and the groove fills the rest.
			expect(tui.virtualScrollNewRows).toBe(3);
			expect(column.slice(0, 9).join("")).toBe("│││││││█│");
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("reports how far back the reader is, in rows", async () => {
		// The host reads this for its own affordances; it must count the whole
		// distance to the live tail, not just the rows still in the frame.
		const { term, tui, scheduler } = await session();
		try {
			expect(tui.virtualScrollNewRows).toBe(0);
			term.sendInput(WHEEL_UP);
			await scheduler.drain(term);
			expect(tui.virtualScrollNewRows).toBe(3);

			scheduler.advance(400); // let the accel streak lapse: base step again
			term.sendInput(WHEEL_UP);
			await scheduler.drain(term);
			expect(tui.virtualScrollNewRows).toBe(6);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("resumes following on submit and on a footer click, from deep in history", async () => {
		// Both host hooks must work from a scroll position the frame does not
		// contain: scrollToLiveTail (submit) and a left click in the footer.
		const { term, tui, scheduler } = await session();
		try {
			for (let i = 0; i < 20; i++) {
				term.sendInput(WHEEL_UP);
				await scheduler.drain(term);
			}
			expect(tui.virtualScrollActive).toBe(true);
			tui.scrollToLiveTail();
			await scheduler.drain(term);
			expect(tui.virtualScrollActive).toBe(false);
			expect(view(term)[9]).toBe(">");

			for (let i = 0; i < 20; i++) {
				term.sendInput(WHEEL_UP);
				await scheduler.drain(term);
			}
			expect(tui.virtualScrollActive).toBe(true);
			term.sendInput("\x1b[<0;5;10M"); // left click on the footer row
			await scheduler.drain(term);
			expect(tui.virtualScrollActive).toBe(false);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("does not freeze on a wheel-up in a session with nothing above the window", async () => {
		// A fresh short screen has no history and no overflow: the wheel is not
		// even captured, so drag-select still works and no frozen state exists.
		const { term, tui, scheduler } = await session(0, 20);
		try {
			expect(tui.scrollTapeRows).toBe(0);
			term.sendInput(WHEEL_UP);
			await scheduler.drain(term);
			expect(tui.virtualScrollActive).toBe(false);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("returns the reader to the live tail when a rebuild erases the history behind them", async () => {
		// With `tui.scrollbackRebuild` on (off by default), a divergence erases
		// native scrollback and replays. The tape mirrors the terminal, so it is
		// reset with it and the frozen view resumes: showing rows the terminal no
		// longer holds would make the engine's own record disagree with the
		// screen, which is the one thing the tape must never do.
		const term = new VirtualTerminal(WIDTH, HEIGHT, 5_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		const transcript = new VirtualizedTranscript();
		const composer = new Composer();
		tui.addChild(transcript);
		tui.addChild(composer);
		tui.setFocus(composer);
		tui.setScrollIsolation(true);
		tui.setPinnedFooterChildCount(1);
		tui.setScrollbackRebuild(true);
		transcript.all = row(0, 8);
		tui.start();
		await scheduler.drain(term);
		try {
			for (let i = 0; i < 12; i++) {
				transcript.all = [...transcript.all, ...row(transcript.all.length, 5)];
				tui.requestRender();
				await scheduler.drain(term);
			}
			// The rebuild path erased and replayed, so nothing older than the
			// replayed frame is on the tape and there is nothing to scroll back to.
			expect(tui.scrollTapeRows).toBeLessThanOrEqual(HEIGHT);
			term.sendInput(WHEEL_UP);
			await scheduler.drain(term);
			expect(view(term)[9]).toBe(">"); // and the composer is still pinned
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("bounds the tape and keeps at least one screen of it", async () => {
		// The tape cannot grow without limit in a long session; older rows stay
		// reachable through the terminal's own scrollback. The floor is one
		// screen, because a shorter tape has nothing to show when frozen.
		const { term, tui, scheduler } = await session();
		try {
			const grown = tui.scrollTapeRows;
			expect(grown).toBeGreaterThan(30);

			tui.setScrollTapeCap(20);
			expect(tui.scrollTapeRows).toBe(20);
			term.sendInput(WHEEL_UP);
			await scheduler.drain(term);
			expect(tui.virtualScrollActive).toBe(true); // still scrollable, just shallower

			tui.setScrollTapeCap(1); // below one screen: floored, not accepted
			expect(tui.scrollTapeRows).toBe(HEIGHT);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});
