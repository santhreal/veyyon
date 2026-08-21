/**
 * WHY: the renderer keeps several absolute row coordinates in "frame space" —
 * the row index inside the current logical frame. When a virtualized transcript
 * drops rows off the front (native scrollback compaction), every one of those
 * coordinates has to slide by the number of rows dropped, or it points at the
 * wrong row for the rest of the session.
 *
 * The drop block slid `#committedRows`, `#committedPrefix`,
 * `#committedPrefixAuditRows`, `#windowTopRow` and `#previousFrameLength`, and
 * forgot `#hardwareCursorRow`. That field is where the terminal cursor actually
 * is, and every incremental paint is cursor-relative: `#emitUpdate` derives
 * `currentScreenRow = clampedCursor - prevWindowTop` and then moves the cursor
 * up by that many rows before writing. Left `dropped` rows too large, the move
 * lands the paint above where it belongs, so the new rows overwrite live
 * transcript output and the previous paint's tail stays on screen underneath —
 * two stacked copies of an anchored block, the transcript card gone. Observed
 * as an intermittent (~50%) failure of
 * `packages/coding-agent/test/modes/todo-mid-turn-render.test.ts`.
 *
 * The class this closes: any drop-time renumbering that misses a frame-space
 * field. The assertion is not "the board is not duplicated" (the incident) but
 * "after every frame the viewport equals the bottom window of the composed
 * frame" (the invariant), checked against a model computed independently of the
 * renderer, on every step of a run that drops rows repeatedly.
 *
 * What it does not catch: coordinates that are wrong in ways a full repaint
 * hides (the engine repaints absolutely often enough to heal some drift within
 * one frame), and drift in fields no paint path reads. It also does not model a
 * real transcript's wrapping or styling — the rows here are plain ASCII, so a
 * width-dependent miscount would not show up.
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
import { settleFrames } from "./helpers/settle-frames";
import { VirtualTerminal } from "./virtual-terminal";

const WIDTH = 40;
const HEIGHT = 10;
/** Rows appended per step: more than one, so a drop is never a single row. */
const ROWS_PER_STEP = 3;
/** Steps driven. Enough that drops start and then repeat many times over. */
const STEPS = 12;

/**
 * A transcript that behaves the way the real one does: it hands the engine every
 * row it still holds, and once the engine reports rows committed to native
 * scrollback it drops all but the retain window off the front and reports how
 * many it dropped.
 */
class VirtualizedHistory implements Component, NativeScrollbackCommittedRows, NativeScrollbackCompaction {
	#lines: string[] = [];
	#committed = 0;
	#retain = 0;
	#pendingDropped = 0;
	/** Total rows this component has ever dropped, for the fail-by-default check. */
	dropCount = 0;

	invalidate(): void {}

	append(count: number, tag: string): void {
		for (let index = 0; index < count; index += 1) {
			this.#lines.push(`${tag}-${this.#lines.length}`);
		}
	}

	/** The rows currently held, without the drop side effect `render` carries. */
	snapshot(): string[] {
		return [...this.#lines];
	}

	setNativeScrollbackCommittedRows(rows: number): void {
		this.#committed = rows;
	}

	setNativeScrollbackRetainRows(rows: number): void {
		this.#retain = rows;
	}

	takeNativeScrollbackDroppedRows(): number {
		const dropped = this.#pendingDropped;
		this.#pendingDropped = 0;
		return dropped;
	}

	render(): string[] {
		const droppable = Math.min(this.#committed, this.#lines.length) - this.#retain;
		if (droppable > 0) {
			this.#lines.splice(0, droppable);
			this.#committed -= droppable;
			this.#pendingDropped += droppable;
			this.dropCount += droppable;
		}
		return [...this.#lines];
	}
}

/** The anchored HUD: a live region that starts at its own first row. */
class AnchoredBlock extends Container implements NativeScrollbackLiveRegion {
	getNativeScrollbackLiveRegionStart(): number {
		return 0;
	}
}

/**
 * The HUD's content, carrying a frame counter so consecutive frames differ in
 * every row — a stale row from the previous paint cannot be mistaken for a
 * correct one.
 */
class MotionBlock implements Component {
	frame = 0;

	invalidate(): void {}

	render(): string[] {
		return [`hud frame ${this.frame}`, `hud alpha ${this.frame}`, `hud beta ${this.frame}`];
	}
}

/** The bottom-`HEIGHT` window of the composed frame, blank-padded like a viewport. */
function expectedViewport(history: VirtualizedHistory, hud: MotionBlock): string[] {
	const frame = [...history.snapshot(), ...hud.render()];
	const window = frame.slice(Math.max(0, frame.length - HEIGHT));
	while (window.length < HEIGHT) {
		window.push("");
	}
	return window;
}

function actualViewport(term: VirtualTerminal): string[] {
	return term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
}

describe("a dropped history row slides the tracked cursor", () => {
	test("every frame after a compaction paints the window the frame composes to", async () => {
		const term = new VirtualTerminal(WIDTH, HEIGHT);
		const tui = new TUI(term);
		const history = new VirtualizedHistory();
		const hud = new AnchoredBlock();
		const motion = new MotionBlock();
		hud.addChild(motion);
		tui.addChild(history);
		tui.addChild(hud);
		tui.start();

		try {
			for (let step = 0; step < STEPS; step += 1) {
				history.append(ROWS_PER_STEP, `s${step}`);
				motion.frame = step + 1;
				tui.requestRender();
				await settleFrames(term, tui);
				expect(actualViewport(term)).toEqual(expectedViewport(history, motion));
			}
		} finally {
			tui.stop();
		}

		// Fail by default: a run that never compacted proves nothing about the
		// drop-time renumbering this suite exists to defend.
		expect(history.dropCount).toBeGreaterThan(0);
	});
});
