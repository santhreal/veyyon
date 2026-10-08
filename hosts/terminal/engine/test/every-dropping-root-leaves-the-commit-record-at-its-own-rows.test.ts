/**
 * WHY: a root child that drops committed rows out of the front of its render
 * reports how many, and the engine removes exactly those rows from its commit
 * record. The record of a frame's drops was one offset and one sum: the
 * topmost dropping root's start and the total over every root. A single
 * dropping root, or adjacent roots that each drop every committed row they
 * hold, splice the same rows under that shape. Any other arrangement does not:
 * with a committed row between two dropping roots, or a first root that keeps
 * a retain window, the one splice removes rows that are still in the frame and
 * leaves dropped rows in the record. The record no longer matches the frame,
 * and the next audit re-anchors at the misaligned row and recommits history
 * the terminal already holds, or erases native scrollback and replays it.
 *
 * Two roots drop in one frame in production when the welcome hero is dismissed
 * on a resumed session: the hero empties a card the transcript below it already
 * pushed into native scrollback, and the transcript compacts its own committed
 * rows in the same compose.
 *
 * THE CLASS, not the incident. The sweep builds every arrangement the grammar
 * below generates: one to three dropping roots, each either emptying (the hero)
 * or keeping a retain row (the transcript), with or without committed static
 * rows above the first and between each pair, all armed to drop in one frame.
 * The invariant checked after every frame is the one a reader sees: the
 * terminal's buffer is the uncompacted frame, every row once and in order, and
 * no frame erases scrollback or clears the viewport.
 *
 * Against the single-offset record 60 of the 84 arrangements fail, each with
 * rows the terminal already held committed a second time. The 24 that pass are
 * the single roots and the arrangements with no static row between dropping
 * roots and at most one root above the last that keeps a row: there the record
 * differs from the frame by at most one row, which the audit's one-edited-row
 * tolerance accepts and overwrites with the frame's row. Splicing the pairs
 * first to last instead of last to first fails 80 of 84.
 *
 * WHAT IT DOES NOT CATCH. Drops spread over separate frames (each frame then
 * holds one drop, which the single-offset record also handled), a dropping
 * root below the live region, rows that wrap, and a multiplexer pane, where
 * the divergence repair takes a different branch.
 */
import { describe, expect, test } from "bun:test";
import {
	type Component,
	Container,
	type NativeScrollbackCommittedRows,
	type NativeScrollbackCompaction,
	type NativeScrollbackLiveRegion,
	TUI,
} from "../src/index";
import { countDestructivePaints } from "./helpers/destructive-paints";
import { settleFrames } from "./helpers/settle-frames";
import { VirtualTerminal } from "./virtual-terminal";

const WIDTH = 40;
const HEIGHT = 8;
/** Rows each dropping root holds before it drops. */
const DROPPING_ROWS = 5;
/** Rows of a static spacer above or between dropping roots. */
const SPACER_ROWS = 2;
/** Frames driven after the drop, so later audits read the slid record. */
const FRAMES_AFTER_DROP = 4;

/** A root that, once armed, drops committed rows down to `keep` and reports the count. */
class DroppingRoot implements Component, NativeScrollbackCommittedRows, NativeScrollbackCompaction {
	readonly #rows: string[];
	#first = 0;
	#committed = 0;
	#pending = 0;
	armed = false;
	dropped = 0;

	constructor(
		tag: string,
		readonly keep: number,
	) {
		this.#rows = Array.from({ length: DROPPING_ROWS }, (_, row) => `${tag}-${row}`);
	}

	invalidate(): void {}

	/** Every row this root rendered, the dropped ones included. */
	history(): readonly string[] {
		return this.#rows;
	}

	setNativeScrollbackCommittedRows(rows: number): void {
		this.#committed = rows;
	}

	takeNativeScrollbackDroppedRows(): number {
		const rows = this.#pending;
		this.#pending = 0;
		return rows;
	}

	render(): string[] {
		if (this.armed) {
			const drop = Math.max(0, Math.min(this.#committed, this.#rows.length - this.#first) - this.keep);
			this.#first += drop;
			this.#committed -= drop;
			this.#pending += drop;
			this.dropped += drop;
		}
		return this.#rows.slice(this.#first);
	}
}

/** Rows that never drop; the tail grows one row per frame so every frame commits. */
class StaticRoot implements Component {
	readonly #rows: string[] = [];

	constructor(
		readonly tag: string,
		rows: number,
	) {
		for (let row = 0; row < rows; row++) this.grow();
	}

	invalidate(): void {}

	grow(): void {
		this.#rows.push(`${this.tag}-${this.#rows.length}`);
	}

	history(): readonly string[] {
		return this.#rows;
	}

	render(): string[] {
		return [...this.#rows];
	}
}

/** The chrome under the transcript: a live region from its first row. */
class Chrome extends Container implements NativeScrollbackLiveRegion {
	frame = 0;

	getNativeScrollbackLiveRegionStart(): number {
		return 0;
	}

	override render(): string[] {
		return [`chrome ${this.frame}`, `status ${this.frame}`];
	}
}

/** One dropping root's shape: the rows it keeps, and whether a static spacer sits above it. */
interface RootSpec {
	keep: 0 | 1;
	spacerAbove: boolean;
}

/** Every arrangement of `count` dropping roots the grammar produces. */
function arrangements(count: number): RootSpec[][] {
	let shapes: RootSpec[][] = [[]];
	for (let index = 0; index < count; index++) {
		const next: RootSpec[][] = [];
		for (const shape of shapes) {
			for (const keep of [0, 1] as const) {
				for (const spacerAbove of [false, true]) next.push([...shape, { keep, spacerAbove }]);
			}
		}
		shapes = next;
	}
	return shapes;
}

function describeShape(shape: readonly RootSpec[]): string {
	return shape.map(spec => `${spec.spacerAbove ? "spacer+" : ""}${spec.keep === 0 ? "empties" : "keeps1"}`).join(" ");
}

/** The terminal's buffer, styled bytes stripped, trailing blank rows dropped. */
function buffer(term: VirtualTerminal): string[] {
	const rows = term.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
	while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
	return rows;
}

async function run(shape: readonly RootSpec[]): Promise<void> {
	const term = new VirtualTerminal(WIDTH, HEIGHT, 10_000);
	const paints = countDestructivePaints(term);
	const tui = new TUI(term);
	const historyRoots: Array<DroppingRoot | StaticRoot> = [];
	const dropping: DroppingRoot[] = [];
	shape.forEach((spec, index) => {
		if (spec.spacerAbove) historyRoots.push(new StaticRoot(`spacer${index}`, SPACER_ROWS));
		const root = new DroppingRoot(`root${index}`, spec.keep);
		dropping.push(root);
		historyRoots.push(root);
	});
	// Enough rows under the last dropping root that every dropping root sits
	// wholly above the viewport, so every row it drops is a committed row.
	const tail = new StaticRoot("tail", HEIGHT);
	historyRoots.push(tail);
	const chrome = new Chrome();
	for (const root of historyRoots) tui.addChild(root);
	tui.addChild(chrome);

	const expectFrameHeld = (): void => {
		const uncompacted = [...historyRoots.flatMap(root => root.history()), ...chrome.render()];
		expect(buffer(term)).toEqual(uncompacted);
	};
	const step = async (): Promise<void> => {
		tail.grow();
		chrome.frame++;
		tui.requestRender();
		await settleFrames(term, tui);
		expectFrameHeld();
	};

	tui.start();
	let firstPaint = { erases: 0, clears: 0 };
	try {
		await settleFrames(term, tui);
		expectFrameHeld();
		firstPaint = { erases: paints.erases(), clears: paints.clears() };
		// Frames before the drop publish each root's committed claim.
		await step();
		await step();
		expect(dropping.map(root => root.dropped)).toEqual(dropping.map(() => 0));

		for (const root of dropping) root.armed = true;
		await step();
		// Fail by default: an arrangement in which a root dropped nothing proves
		// nothing about a frame that splices several drops.
		for (const root of dropping) expect(root.dropped).toBeGreaterThan(0);

		for (let frame = 0; frame < FRAMES_AFTER_DROP; frame++) await step();
	} finally {
		tui.stop();
	}
	// The first paint may clear the viewport it starts on; no later frame may.
	expect({ erases: paints.erases(), clears: paints.clears() }).toEqual(firstPaint);
}

describe("every dropping root leaves the commit record at its own rows", () => {
	for (const count of [1, 2, 3]) {
		for (const shape of arrangements(count)) {
			test(describeShape(shape), () => run(shape));
		}
	}
});
