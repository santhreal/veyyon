/**
 * A screen the engine did not compose is adopted whole, or not at all.
 *
 * THE DEFECT CLASS. `adoptPaintedWindow` tells the engine the terminal already shows a frame, so
 * the next render writes only what differs from it. Every field it seeds is one an incremental
 * update reads: the rows it diffs against, the geometry that decides whether the frame is a
 * resize, and the two positions -- the cursor row and the window top -- that RELATIVE motion is
 * measured from. A field that is not seeded is a frame written at an offset, and both positions
 * were found exactly that way: a card that reappeared one row further down the screen.
 *
 * THE ORACLE. No arm asserts hand-written rows. Each compares the adopting terminal's own grid,
 * read back through a real VT parser, against a SECOND engine that composed the same final state
 * cold with nothing to adopt. Cold compose is the definition of correct, so an adopted frame that
 * differs from it in any cell fails whatever the difference is.
 *
 * FAILING BY DEFAULT. The per-field arm enumerates `paintedScreen()`'s own keys at run time and
 * fails on a key it has no expectation for, so a sixth field added to `AdoptedScreen` turns this
 * red until someone records what corrupting it does.
 *
 * WHAT IT DOES NOT CATCH. Nothing here proves a recording written by ONE process describes the
 * screen of ANOTHER; that is `first-frame-replay`'s suite in coding-agent. An adopted screen
 * holding transcript history is out of scope by construction: the commit ledger, the scroll tape
 * and the committed prefix are not seeded and stay empty, which the method documents.
 */
import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "@veyyon/tui";
import type { AdoptedScreen } from "@veyyon/tui/tui";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

const COLUMNS = 40;
const ROWS = 12;

/** A root whose rows the test sets, the way live content changes them. */
class Block implements Component {
	#lines: readonly string[];

	constructor(lines: readonly string[]) {
		this.#lines = lines;
	}

	set(lines: readonly string[]): void {
		this.#lines = lines;
	}

	invalidate(): void {}

	render(_width: number): readonly string[] {
		return this.#lines;
	}
}

function strip(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
}

function rowsOf(label: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `${label}-${i + 1}`);
}

const CARD = rowsOf("card", 6);

interface Recording {
	bytes: string;
	screen: AdoptedScreen;
}

/** Paint `lines` cold and hand back what a launch would record: the bytes, and the screen. */
async function record(lines: readonly string[]): Promise<Recording> {
	const term = new VirtualTerminal(COLUMNS, ROWS, 1_000);
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	tui.addChild(new Block(lines));
	let bytes = "";
	try {
		tui.start();
		// The recording starts after `start`, exactly as the launch path does it: the capability
		// queries `start` emits must never be replayed, because a replayed query means an answer
		// arriving with nobody expecting it.
		const passThrough = term.write.bind(term);
		term.write = (data: string): void => {
			bytes += data;
			passThrough(data);
		};
		tui.requestRender();
		await scheduler.drain(term);
		term.write = passThrough;
		return { bytes, screen: structuredClone(tui.paintedScreen()) as AdoptedScreen };
	} finally {
		tui.stop();
		await term.flush();
	}
}

/** What a cold engine paints for `lines`: the oracle every adopting arm is compared against. */
async function coldViewport(lines: readonly string[]): Promise<string[]> {
	const term = new VirtualTerminal(COLUMNS, ROWS, 1_000);
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	tui.addChild(new Block(lines));
	try {
		tui.start();
		tui.requestRender();
		await scheduler.drain(term);
		return strip(term.getViewport());
	} finally {
		tui.stop();
		await term.flush();
	}
}

interface Replayed {
	viewport: string[];
	/** Bytes the engine wrote AFTER the replay, which is the whole cost of the adopted launch. */
	written: string;
	/**
	 * `composedFrameRows` as the engine reports it between adoption and the first frame. The home
	 * anchor reads it in exactly that window to size the gap above the composer, so an adopted
	 * screen that reports the wrong number puts the composer on the wrong row before any render
	 * has had a chance to correct it.
	 */
	frameRowsAtAdoption: number;
}

/**
 * The production sequence: a second process finds a recording, writes its bytes to the terminal,
 * adopts the screen they painted, and renders `lines`.
 */
async function replay(recording: Recording, lines: readonly string[]): Promise<Replayed> {
	const term = new VirtualTerminal(COLUMNS, ROWS, 1_000);
	term.write(recording.bytes);
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	tui.addChild(new Block(lines));
	let written = "";
	try {
		tui.adoptPaintedWindow(recording.screen);
		tui.start();
		const passThrough = term.write.bind(term);
		term.write = (data: string): void => {
			written += data;
			passThrough(data);
		};
		const frameRowsAtAdoption = tui.composedFrameRows;
		tui.requestRender();
		await scheduler.drain(term);
		term.write = passThrough;
		return { viewport: strip(term.getViewport()), written, frameRowsAtAdoption };
	} finally {
		tui.stop();
		await term.flush();
	}
}

describe("a replayed screen the engine adopts", () => {
	it("shows what a cold compose shows, and costs nothing to agree with", async () => {
		const recording = await record(CARD);
		const replayed = await replay(recording, CARD);
		expect(replayed.viewport).toEqual(await coldViewport(CARD));
		// The whole point: the rows are already right, so the diff has nothing to say. Not "few
		// bytes" -- none, because every row matches and the cursor is already parked.
		expect(replayed.written).toBe("");
	});

	it("does not erase the rows it was handed", async () => {
		const recording = await record(CARD);
		const replayed = await replay(recording, CARD);
		// ED 2 is the full-paint tell. A first render that clears is the blink-and-reassemble this
		// exists to remove, and it passes the viewport comparison above, so it needs its own arm.
		expect(replayed.written).not.toContain("\x1b[2J");
	});

	it("corrects a row that changed since the recording, and only that row", async () => {
		const recording = await record(CARD);
		const changed = [...CARD];
		changed[3] = "card-4-changed";
		const replayed = await replay(recording, changed);
		expect(replayed.viewport).toEqual(await coldViewport(changed));
		expect(replayed.written).toContain("card-4-changed");
		// The rows that did not change are not rewritten. `card-1` appears in the replayed bytes,
		// so a full repaint here is a rewrite of content the terminal already holds.
		expect(replayed.written).not.toContain("card-1");
	});

	it("shows what a cold compose shows when the frame grew", async () => {
		const recording = await record(CARD);
		const taller = rowsOf("card", 9);
		expect(await replay(recording, taller).then(r => r.viewport)).toEqual(await coldViewport(taller));
	});

	it("shows what a cold compose shows when the frame shrank", async () => {
		const recording = await record(CARD);
		const shorter = rowsOf("card", 2);
		expect(await replay(recording, shorter).then(r => r.viewport)).toEqual(await coldViewport(shorter));
	});
});

/** The frame every corruption arm renders: one row of the card has moved on since the recording. */
const CHANGED = CARD.map((row, at) => (at === 3 ? "card-4-changed" : row));

/**
 * What a wrong value in one adopted field does to the frame after it. Every arm renders {@link
 * CHANGED} rather than the recorded card, because a frame with nothing to say writes nothing and
 * hides a wrong position: an off-by-one cursor is only visible once something is written relative
 *   "paints wrong"      -- the engine believes the corrupted value and the terminal ends up
 *                          showing something a cold compose never paints. Unrecoverable: the diff
 *                          has already decided those rows are correct and will not revisit them.
 *   "repaints"          -- the mismatch is structural, so the engine discards the adoption and
 *                          writes the frame in full. The right screen at the price adoption exists
 *                          to avoid, which is why the arm asserts the byte count and not the rows.
 *   "misreports size"   -- the rows are right and the engine's own account of the frame is not,
 *                          which is read before the first render and never appears on screen.
 */
const FIELD_CORRUPTIONS: Record<
	keyof AdoptedScreen,
	{
		wrong: (recorded: AdoptedScreen, changed: AdoptedScreen) => AdoptedScreen;
		outcome: "misreports size" | "repaints" | "paints wrong";
	}
> = {
	// The row the terminal actually shows is the OLD one; the adopted screen claims it already
	// shows the new one. The diff skips it and the stale row stays on screen forever. This is what
	// a recording that does not describe its own bytes does, and no length check can see it.
	window: {
		wrong: (recorded, changed) => ({
			...recorded,
			window: recorded.window.map((row, at) => changed.window[at] ?? row),
		}),
		outcome: "paints wrong",
	},
	width: { wrong: recorded => ({ ...recorded, width: recorded.width - 1 }), outcome: "repaints" },
	height: { wrong: recorded => ({ ...recorded, height: recorded.height - 1 }), outcome: "repaints" },
	cursorRow: { wrong: recorded => ({ ...recorded, cursorRow: recorded.cursorRow + 1 }), outcome: "paints wrong" },
	windowTopRow: { wrong: recorded => ({ ...recorded, windowTopRow: recorded.windowTopRow + 1 }), outcome: "repaints" },
	// The window is padded to the viewport and the frame is not, so `window.length` is the wrong
	// number and the closest wrong number there is. Nothing on screen can see the difference.
	frameLength: {
		wrong: recorded => ({ ...recorded, frameLength: recorded.window.length }),
		outcome: "misreports size",
	},
};

describe("every field of an adopted screen", () => {
	it("has a recorded consequence, so a new one fails until someone records it", async () => {
		const recording = await record(CARD);
		expect(Object.keys(FIELD_CORRUPTIONS).sort()).toEqual(Object.keys(recording.screen).sort());
	});

	for (const [field, { wrong, outcome }] of Object.entries(FIELD_CORRUPTIONS) as [
		keyof AdoptedScreen,
		(typeof FIELD_CORRUPTIONS)[keyof AdoptedScreen],
	][]) {
		it(`${outcome} when ${field} is wrong`, async () => {
			const recording = await record(CARD);
			const changedRecording = await record(CHANGED);
			const oracle = await coldViewport(CHANGED);
			const clean = await replay(recording, CHANGED);
			expect(clean.viewport).toEqual(oracle);
			const corrupt = await replay(
				{ bytes: recording.bytes, screen: wrong(recording.screen, changedRecording.screen) },
				CHANGED,
			);
			if (outcome === "misreports size") {
				expect(clean.frameRowsAtAdoption).toBe(CARD.length);
				expect(corrupt.frameRowsAtAdoption).not.toBe(CARD.length);
				return;
			}
			if (outcome === "repaints") {
				expect(corrupt.viewport).toEqual(oracle);
				expect(corrupt.written.length).toBeGreaterThan(clean.written.length);
				return;
			}
			expect(corrupt.viewport).not.toEqual(oracle);
		});
	}
});
