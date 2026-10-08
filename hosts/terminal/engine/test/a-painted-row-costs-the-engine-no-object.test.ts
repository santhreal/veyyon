/**
 * A painted frame costs the engine no object per row, and the prepared rows it keeps still follow
 * the composed rows they were fitted from.
 *
 * THE DEFECT. The prepared-frame cache kept a `{ raw, width, line }` record for every row of the
 * composed frame, for the life of the session. A transcript that is never compacted keeps every row
 * in the frame, so a resumed 600-turn session held 31,661 of these records, 1.48 MiB, the largest
 * object shape in its heap.
 *
 * THE CLASS. Anything the engine retains per frame row as a heap cell of its own: a record, a
 * wrapper, a copied string. The suite paints a 20,000-row frame through the real `TUI` onto a
 * terminal that keeps nothing, and bounds the cells alive after a full garbage collection. Rows are
 * plain ASCII narrower than the terminal, so a fitted row is the composed string itself and the only
 * cells a paint may add are a fixed number of arrays and scalars per frame.
 *
 * The remaining cases pin what the parallel-array cache must still do: a width change retires every
 * fitted row, and rows a shrink dropped are fitted again when the frame grows back to them.
 *
 * WHAT IT DOES NOT CATCH. Array storage (a butterfly) is not a cell, so an extra array of row
 * pointers passes the bound. A row whose fitted form differs from its source (a Thai AM vowel, a row
 * wider than the terminal) is a new string per row by necessity and is not exercised here.
 */

import { heapStats } from "bun:jsc";
import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "@veyyon/tui";
import type { Terminal, TerminalAppearance } from "@veyyon/tui/terminal";
import { settleFrames } from "./helpers/settle-frames";
import { VirtualTerminal } from "./virtual-terminal";

const ROWS = 20_000;

/** A terminal that keeps nothing it is sent, so every cell alive after a paint is the engine's. */
class DiscardTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	kittyEnableSequence: string | null = null;
	keyboardEnhancementEnterSequence: string | null = null;
	keyboardEnhancementExitSequence: string | null = null;
	appearance: TerminalAppearance | undefined;
	bytes = 0;

	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}
	write(data: string): void {
		this.bytes += data.length;
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	onAppearanceChange(_callback: (appearance: TerminalAppearance) => void): void {}
}

class Rows implements Component {
	lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(): readonly string[] {
		return this.lines;
	}
	invalidate(): void {}
}

/** Cells alive after a full collection, by JSC cell type. */
function liveCells(): Record<string, number> {
	Bun.gc(true);
	Bun.gc(true);
	return heapStats().objectTypeCounts;
}

/** Cells of each type that grew between two counts; a type that shrank adds nothing. */
function grownCells(before: Record<string, number>, after: Record<string, number>): number {
	let grown = 0;
	for (const [type, count] of Object.entries(after)) grown += Math.max(0, count - (before[type] ?? 0));
	return grown;
}

/**
 * Flat rows, built in a frame of their own. A template literal is a rope whose number fiber dies
 * when a paint flattens it, and an intermediate array left in the test's own frame is held by a
 * bytecode temporary until the frame moves on; either dies after the baseline and would cancel a
 * cell per row the engine kept. The JSON round trip returns flat strings and the intermediates
 * die with this frame.
 */
function flatRows(count: number): string[] {
	return JSON.parse(
		JSON.stringify(Array.from({ length: count }, (_, i) => `transcript row ${i} of the painted frame`)),
	);
}

describe("a painted frame", () => {
	it("leaves no cell per row alive in the engine", async () => {
		const term = new DiscardTerminal();
		const tui = new TUI(term);
		const block = new Rows(Array.from({ length: 12 }, (_, i) => `warm row ${i}`));
		tui.addChild(block);
		tui.start();
		try {
			await settleFrames(term, tui);
			// The rows exist before the baseline: the component owns them, the engine only points at them.
			const rows = flatRows(ROWS);
			const before = liveCells();
			block.lines = rows;
			tui.requestRender();
			await settleFrames(term, tui);
			const grown = grownCells(before, liveCells());

			expect(tui.composedFrameRows).toBe(ROWS);
			expect(term.bytes).toBeGreaterThan(ROWS * 20);
			// One record per row was 20,000 cells; a paint without one adds a few hundred at most.
			expect(grown).toBeLessThan(ROWS / 10);
			expect(rows.length).toBe(ROWS);
		} finally {
			tui.stop();
		}
	});
});

describe("the prepared rows", () => {
	it("are fitted again at the new width after a resize", async () => {
		// Outside a multiplexer a resize paints a stateless viewport first and replays through the
		// cache on a settle timer; the in-place repaint reaches the cache on the resize frame itself.
		const inPlace = Bun.env.VEYYON_TUI_RESIZE_IN_PLACE;
		Bun.env.VEYYON_TUI_RESIZE_IN_PLACE = "1";
		const term = new VirtualTerminal(80, 6);
		const sent: string[] = [];
		const write = term.write.bind(term);
		term.write = (data: string) => {
			sent.push(data);
			write(data);
		};
		const tui = new TUI(term);
		const wide = `${"a".repeat(30)}${"b".repeat(30)}`;
		const fitted = `${"a".repeat(30)}${"b".repeat(10)}`;
		tui.addChild(new Rows(["head", wide, "tail"]));
		tui.start();
		try {
			await settleFrames(term, tui);
			expect(sent.join("")).toContain(wide);

			sent.length = 0;
			term.resize(40, 6);
			await settleFrames(term, tui);
			// A paint turns auto-wrap off, so the terminal clips an unfitted row and its screen cannot
			// show one. The bytes can: every row the engine sends after the resize fits 40 cells.
			const repaint = sent.join("");
			expect(repaint).toContain(fitted);
			expect(repaint).not.toContain(wide);
			const viewport = term.getViewport().map(line => line.trimEnd());
			expect(viewport).toContain(fitted);
			expect(viewport).toContain("tail");
		} finally {
			tui.stop();
			if (inPlace === undefined) delete Bun.env.VEYYON_TUI_RESIZE_IN_PLACE;
			else Bun.env.VEYYON_TUI_RESIZE_IN_PLACE = inPlace;
		}
	});

	it("follow a row whose text changed in place", async () => {
		const term = new VirtualTerminal(80, 6);
		const tui = new TUI(term);
		const block = new Rows(["first row", "second row", "third row"]);
		tui.addChild(block);
		tui.start();
		try {
			await settleFrames(term, tui);
			block.lines = ["first row", "moved row", "third row"];
			tui.requestRender();
			await settleFrames(term, tui);
			const viewport = term.getViewport().map(line => line.trimEnd());
			expect(viewport).toContain("moved row");
			expect(viewport).not.toContain("second row");
		} finally {
			tui.stop();
		}
	});

	it("paint the rows a frame regains after it shrank", async () => {
		const term = new VirtualTerminal(80, 8);
		const tui = new TUI(term);
		const rows = ["first row", "second row", "third row", "fourth row"];
		const block = new Rows(rows);
		tui.addChild(block);
		tui.start();
		try {
			await settleFrames(term, tui);
			block.lines = rows.slice(0, 1);
			tui.requestRender();
			await settleFrames(term, tui);
			expect(term.getViewport().map(line => line.trimEnd())).not.toContain("third row");

			// The same string objects return at the positions they held before the shrink.
			block.lines = rows;
			tui.requestRender();
			await settleFrames(term, tui);
			const viewport = term.getViewport().map(line => line.trimEnd());
			for (const row of rows) expect(viewport).toContain(row);
		} finally {
			tui.stop();
		}
	});
});
