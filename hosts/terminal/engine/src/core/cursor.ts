/**
 * Where the hardware cursor is, and what the terminal has been told about it.
 *
 * The engine paints a software caret; the hardware cursor exists for the IME candidate window,
 * which the terminal positions at the real cursor. So the tracker's job is not "draw a cursor" but
 * "know what the terminal currently believes", because every cursor move is emitted as a RELATIVE
 * sequence from the row the terminal is on. Get that belief wrong and the candidate window opens on
 * the wrong row, or a `CSI ?25h` re-shows a cursor the frame just hid.
 *
 * Three states, not two. `visibilityKnown` is false after anything that invalidates the terminal's
 * cursor state without telling us where it landed (a resize, a full repaint, an alt-screen switch);
 * a write is then unconditional rather than diffed against a stale belief.
 */
import { clampLow } from "@veyyon/utils/math";

/** What the terminal is believed to be showing: a position and whether the cursor is drawn there. */
export interface HardwareCursorState {
	row: number;
	col: number;
	visible: boolean;
}

/**
 * The outcome of a paint, as far as the cursor is concerned. `state` is null when the paint moved
 * the cursor without establishing a full position (the row is known, the column is not).
 */
export interface HardwareCursorUpdate {
	toRow: number;
	state: HardwareCursorState | null;
	visible?: boolean;
}

/** A cursor move ready to append into a paint: the bytes, plus what they will make true. */
export interface CursorControlResult extends HardwareCursorUpdate {
	seq: string;
	toCol: number;
	visible: boolean;
}

/** The single terminal call this tracker makes on its own, so it needs no `Terminal` import. */
export interface CursorWriter {
	write(data: string): void;
	hideCursor(): void;
}

export class HardwareCursorTracker {
	/** Actual terminal cursor row (may differ from the caret due to IME positioning). */
	row = 0;
	#state: HardwareCursorState | null = null;
	#visibilityKnown = false;
	#visible = false;
	#show: boolean;
	#beginSequence: string;
	#endSequence: string;

	constructor(show: boolean, beginSequence: string, endSequence: string) {
		this.#show = show;
		this.#beginSequence = beginSequence;
		this.#endSequence = endSequence;
	}

	/** Whether the operator asked for a real terminal cursor at all. */
	get show(): boolean {
		return this.#show;
	}

	/** Record the preference. Returns whether it changed, which is what decides a repaint. */
	setShow(show: boolean): boolean {
		if (this.#show === show) return false;
		this.#show = show;
		return true;
	}

	/** Synchronized output framing for a standalone cursor write. */
	setFraming(beginSequence: string, endSequence: string): void {
		this.#beginSequence = beginSequence;
		this.#endSequence = endSequence;
	}

	/** Where the cursor should end up for this frame, or null when nothing wants one. */
	targetState(cursorPos: { row: number; col: number } | null, totalLines: number): HardwareCursorState | null {
		if (!cursorPos || totalLines <= 0) return null;
		return {
			row: clampLow(cursorPos.row, 0, totalLines - 1),
			col: Math.max(0, cursorPos.col),
			visible: this.#show,
		};
	}

	recordState(state: HardwareCursorState): void {
		this.row = state.row;
		this.#state = state;
		this.#visible = state.visible;
		this.#visibilityKnown = true;
	}

	recordRowOnly(row: number, visible?: boolean): void {
		this.row = row;
		this.#state = null;
		if (visible !== undefined) {
			this.#visible = visible;
			this.#visibilityKnown = true;
		}
	}

	recordUpdate(update: HardwareCursorUpdate): void {
		if (update.state) {
			this.recordState(update.state);
			return;
		}
		this.recordRowOnly(update.toRow, update.visible);
	}

	recordHidden(): void {
		this.#visible = false;
		this.#visibilityKnown = true;
		if (!this.#state) return;
		this.#state = { ...this.#state, visible: false };
	}

	/** The terminal's cursor state is no longer knowable. The next write is unconditional. */
	forget(): void {
		this.#state = null;
		this.#visibilityKnown = false;
	}

	sameState(state: HardwareCursorState): boolean {
		const current = this.#state;
		return (
			current !== null && current.row === state.row && current.col === state.col && current.visible === state.visible
		);
	}

	hiddenKnown(): boolean {
		return this.#visibilityKnown && !this.#visible;
	}

	/**
	 * Build cursor control sequences to position the hardware cursor for the IME candidate window.
	 * Returns escape sequences and the resulting cursor row for the caller to record. The sequences
	 * should be appended into the caller's own synchronized output block to avoid a flicker between
	 * content and cursor frames.
	 */
	controlSequence(
		cursorPos: { row: number; col: number } | null,
		totalLines: number,
		fromRow: number,
	): CursorControlResult {
		// No IME target or no content — hide cursor regardless of preference.
		const target = this.targetState(cursorPos, totalLines);
		if (!target) {
			return { seq: "\x1b[?25l", toRow: fromRow, toCol: 0, visible: false, state: null };
		}

		// Move cursor from current position to target.
		const rowDelta = target.row - fromRow;
		let seq = "";
		if (rowDelta > 0) {
			seq += `\x1b[${rowDelta}B`; // Move down
		} else if (rowDelta < 0) {
			seq += `\x1b[${-rowDelta}A`; // Move up
		}
		// Move to absolute column (1-indexed)
		seq += `\x1b[${target.col + 1}G`;
		seq += target.visible ? "\x1b[?25h" : "\x1b[?25l";

		return { seq, toRow: target.row, toCol: target.col, visible: target.visible, state: target };
	}

	/**
	 * Write the hardware cursor position to the terminal as a standalone synchronized output block.
	 * Use when there is no surrounding render buffer to embed the sequences into.
	 */
	writePosition(terminal: CursorWriter, cursorPos: { row: number; col: number } | null, totalLines: number): void {
		const target = this.targetState(cursorPos, totalLines);
		if (!target) {
			if (this.hiddenKnown()) return;
			terminal.hideCursor();
			this.recordHidden();
			return;
		}
		if (this.sameState(target)) return;
		const cursorControl = this.controlSequence(cursorPos, totalLines, this.row);
		terminal.write(`${this.#beginSequence}${cursorControl.seq}${this.#endSequence}`);
		this.recordUpdate(cursorControl);
	}
}
