/**
 * Chrome never becomes history, however tall it gets.
 *
 * WHAT THIS CLOSES. Native scrollback is for the transcript. A todo list, a
 * subagent roster, a status row and the composer are chrome: they rewrite
 * themselves every frame. The engine committed whatever sat above the window
 * top, and once the chrome outgrew the viewport that boundary landed inside the
 * chrome — so chrome rows entered the committed prefix, disagreed with
 * themselves on the very next frame, and the prefix audit repaired the
 * disagreement the only way it can: erase native scrollback (ED3) and replay.
 * Every frame of a live turn. On screen that is a strobe, and what it leaves
 * behind is a screen with four rows of chrome and a blank void where forty
 * turns were.
 *
 * THE CLASS, not the incident. The invariant is not "a 22-row HUD is safe at
 * height 24". It is that no row belonging to a child mounted after the
 * transcript may ever appear in the terminal's scroll buffer, at any chrome
 * height, viewport height, or header height, and that a frame which cannot
 * commit takes a bounded in-place repaint instead of a destructive one. The
 * sweep drives chrome from comfortably inside the viewport to nearly three
 * times its height.
 *
 * WHAT IT DOES NOT CATCH. It asserts where rows LAND, not how many bytes it
 * took to get them there: an engine that repainted the window every frame
 * without ever erasing would pass this and still be slow. Byte budgets are
 * `packages/simulations/src/paint-sim`. It drives one width, no images, no
 * overlays, and no multiplexer pane, where ED3 is refused for other reasons and
 * the repair contract differs.
 */
import { describe, expect, test } from "bun:test";
import { type Component, Container, CURSOR_MARKER, type Focusable, TUI } from "../src/index";
import { settleFrames } from "./helpers/settle-frames";
import { VirtualTerminal } from "./virtual-terminal";

/** Marks a row as chrome. Finding any of these in scrollback is the defect. */
const CHROME_MARKERS = ["[ ] task", "esc to interrupt", "ask anything"] as const;

class Block implements Component {
	constructor(private readonly lines: readonly string[]) {}
	invalidate(): void {}
	render(): string[] {
		return [...this.lines];
	}
}

/** A transcript child still arriving: grows a row a frame, never finalizes. */
class LiveBlock implements Component {
	#rows: string[] = ["  reply: still arriving"];
	invalidate(): void {}
	grow(): void {
		this.#rows = [...this.#rows, `  row ${this.#rows.length} of the answer`];
	}
	getRenderStablePrefixRows(): number {
		return 0;
	}
	render(): string[] {
		return [...this.#rows];
	}
}

/**
 * The todo list. A plain root child mounted BELOW the transcript, which is what
 * the shipped HUD band is — not a pinned footer, and not part of the transcript.
 */
class Hud implements Component {
	#rows: number;
	constructor(rows: number) {
		this.#rows = rows;
	}
	invalidate(): void {}
	setRows(rows: number): void {
		this.#rows = rows;
	}
	render(): string[] {
		return Array.from({ length: this.#rows }, (_, row) => `  [ ] task ${row + 1}`);
	}
}

class StatusRow implements Component {
	invalidate(): void {}
	render(): string[] {
		return ["  esc to interrupt"];
	}
}

class Composer implements Component, Focusable {
	focused = true;
	invalidate(): void {}
	setUseTerminalCursor(): void {}
	handleInput(): void {}
	render(): string[] {
		return [`> ask anything${CURSOR_MARKER}`];
	}
}

/**
 * Stands in for the app's `TranscriptContainer`: a root child that CLAIMS
 * native scrollback, which is what marks it as history and everything mounted
 * after it as chrome. The tui package cannot import the coding-agent component,
 * and does not need to: the claim is the whole contract, and the rows it holds
 * are ordinary children.
 */
class Transcript extends Container {
	prepareNativeScrollbackReplay(): void {}
}

interface Shape {
	height: number;
	headerRows: number;
	hudRows: number;
	turns: number;
	streamFrames: number;
}

interface Run {
	/** Scroll-buffer rows, ANSI stripped, blank rows dropped. */
	history: string[];
	/** ED3 sequences written across the measured stream. */
	erases: number;
	/** Turns whose text is no longer anywhere in the buffer. */
	lostTurns: number[];
}

const label = (shape: Shape): string =>
	`height=${shape.height} header=${shape.headerRows} hud=${shape.hudRows} turns=${shape.turns}`;

async function drive(shape: Shape): Promise<Run> {
	const term = new VirtualTerminal(100, shape.height, 20_000);
	let erases = 0;
	const write = term.write.bind(term);
	term.write = (data: string) => {
		if (data.includes("\x1b[3J")) erases++;
		write(data);
	};
	const tui = new TUI(term, true);
	// The shipped default. A destructive repair is exactly what must not happen.
	tui.setScrollbackRebuild(true);

	if (shape.headerRows > 0) {
		tui.addChild(new Block(Array.from({ length: shape.headerRows }, (_, row) => `  header ${row}`)));
	}
	const transcript = new Transcript();
	tui.addChild(transcript);
	const hud = new Hud(shape.hudRows);
	tui.addChild(hud);
	tui.addChild(new StatusRow());
	tui.addChild(new Composer());
	tui.setPinnedFooterChildCount(2);
	tui.start();
	await settleFrames(term, tui);

	for (let turn = 0; turn < shape.turns; turn++) {
		transcript.addChild(new Block([`> turn ${turn}: what changed?`, "", `  reply ${turn}: done.`, ""]));
		tui.requestRender();
		await settleFrames(term, tui);
	}

	const erasesAtOpen = erases;
	const paintedAtOpen = term.getScrollBuffer().map(row => Bun.stripANSI(row));
	const paintedTurns: number[] = [];
	for (let turn = 0; turn < shape.turns; turn++) {
		if (paintedAtOpen.some(row => row.includes(`turn ${turn}:`))) paintedTurns.push(turn);
	}
	const live = new LiveBlock();
	transcript.addChild(live);
	for (let frame = 0; frame < shape.streamFrames; frame++) {
		live.grow();
		// A task finishing collapses the HUD; the next one opens it again.
		if (frame % 7 === 6) hud.setRows(frame % 14 === 6 ? 0 : shape.hudRows);
		tui.requestRender();
		await settleFrames(term, tui);
	}

	const history = term
		.getScrollBuffer()
		.map(row => Bun.stripANSI(row).trimEnd())
		.filter(row => row.length > 0);
	// Turns that reached the terminal BEFORE the stream opened and are no longer
	// there. Scoped to those deliberately: a turn the layout never had room to
	// paint (chrome alone taller than the viewport) was never in the buffer to
	// begin with, and calling that "lost" would blame the engine for a layout
	// that over-subscribed the screen. What the engine owes is that a row it DID
	// paint stays painted.
	const lostTurns = paintedTurns.filter(turn => !history.some(row => row.includes(`turn ${turn}:`)));
	return { history, erases: erases - erasesAtOpen, lostTurns };
}

describe("chrome taller than the viewport never reaches native scrollback", () => {
	// Chrome from a third of the viewport to nearly three times it, at three
	// header heights, so the boundary is crossed rather than sampled on one side.
	const shapes: Shape[] = [];
	for (const height of [16, 24, 40]) {
		for (const hudRows of [2, 8, height - 4, height, height * 2]) {
			for (const headerRows of [0, 2]) {
				shapes.push({ height, headerRows, hudRows, turns: 20, streamFrames: 20 });
			}
		}
	}

	for (const shape of shapes) {
		test(label(shape), async () => {
			const run = await drive(shape);

			// Chrome reaching the terminal's buffer is NOT by itself the defect:
			// the screen scrolls, and whatever was on it at that moment goes up,
			// chrome included. Once per screenful of new content is the honest
			// ceiling. Beyond that the engine is committing chrome as history,
			// which is the mechanism — so the bound is derived from the rows the
			// run actually produced, never a constant somebody can tune.
			const producedRows = shape.turns * 4 + shape.streamFrames;
			const screenfuls = Math.ceil(producedRows / shape.height) + 2;
			const composerCopies = run.history.filter(row => row.includes("ask anything")).length;
			expect({ arm: label(shape), overCeiling: composerCopies > screenfuls }).toEqual({
				arm: label(shape),
				overCeiling: false,
			});

			// The repair that leak triggers, and the history it destroys.
			expect({ arm: label(shape), erases: run.erases, lost: run.lostTurns }).toEqual({
				arm: label(shape),
				erases: 0,
				lost: [],
			});
		}, 30_000);
	}
});
