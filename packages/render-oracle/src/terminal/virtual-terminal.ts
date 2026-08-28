import type { Terminal, TerminalAppearance } from "@veyyon/tui/terminal";
import { CellFlags } from "ghostty-web";
import { DEFAULT_SCROLLBACK_LINES } from "./constants";
import {
	engineWrite,
	isAtBottom,
	recreateEngine,
	refollowBottom,
	type VirtualTerminalEngineState,
} from "./engine-recovery";
import { createGhosttyEngine, createGhosttyTerminal } from "./ghostty-engine";
import { activeRowText, cappedBaseY, historyRowText, isDefaultBg, isDefaultFg, presentedRowCells } from "./grid-reader";

/**
 * Virtual terminal for testing, backed by Ghostty's WASM VT engine.
 *
 * The engine models the active screen grid plus a linear scrollback history but
 * has no interactive scroll-viewport (it is always "at the bottom"). The harness
 * relies on xterm-style scroll bookkeeping (`baseY`/`viewportY`/`scrollLines`),
 * so this wrapper emulates that window over `[history ++ active grid]`:
 *
 * - `baseY` is the scrollback line count, clamped to the requested line cap so a
 *   small `scrollback` evicts oldest history exactly like xterm's line cap (the
 *   engine itself evicts by a generous *byte* budget, which we keep far above the
 *   line cap so the clamp is the only eviction the harness observes).
 * - `viewportY` is an absolute scroll offset in `[0, baseY]`; it follows the
 *   bottom on writes/resizes unless the caller scrolled up, matching xterm.
 *
 * This emulation was validated to match `@xterm/headless` bit-for-bit on
 * baseY/viewportY/viewport/scrollBuffer across append, overflow, scroll, write-
 * while-scrolled, and resize sequences.
 */
export class VirtualTerminal implements Terminal {
	readonly #state: VirtualTerminalEngineState;
	#inputHandler?: (data: string) => void;
	#resizeHandler?: () => void;

	constructor(columns = 80, rows = 24, scrollback?: number) {
		const scrollbackCap = scrollback ?? DEFAULT_SCROLLBACK_LINES;
		const ghostty = createGhosttyEngine();
		const term = createGhosttyTerminal(ghostty, columns, rows, scrollbackCap);
		this.#state = {
			ghostty,
			term,
			columns,
			rows,
			scrollbackCap,
			viewportY: 0,
			pendingEngineResize: false,
			engineRebuilds: 0,
			eventLog: [],
			eventLogBytes: 0,
			logBaseColumns: columns,
			logBaseRows: rows,
			replayingLog: false,
			recoveringFromOom: false,
			historyTextCache: [],
		};
	}

	// --- Terminal interface --------------------------------------------------

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.#inputHandler = onInput;
		this.#resizeHandler = onResize;
		// Enable bracketed paste mode for consistency with ProcessTerminal.
		engineWrite(this.#state, "\x1b[?2004h");
	}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {
		// No-op for virtual terminal - no stdin to drain.
	}

	stop(): void {
		engineWrite(this.#state, "\x1b[?2004l\x1b[?5522l");
		this.#inputHandler = undefined;
		this.#resizeHandler = undefined;
	}

	write(data: string): void {
		engineWrite(this.#state, data);
	}

	get columns(): number {
		return this.#state.columns;
	}

	get rows(): number {
		return this.#state.rows;
	}

	get kittyProtocolActive(): boolean {
		// Backed by a real Ghostty engine: the Kitty keyboard protocol is genuinely
		// supported, so tests can rely on it being active.
		return true;
	}

	get kittyEnableSequence(): string | null {
		return "\x1b[>1u";
	}

	get keyboardEnhancementEnterSequence(): string | null {
		return "\x1b[>1u";
	}

	get keyboardEnhancementExitSequence(): string | null {
		return "\x1b[<u";
	}

	get appearance(): TerminalAppearance | undefined {
		return undefined;
	}

	onAppearanceChange(_callback: (appearance: TerminalAppearance) => void): void {
		// No-op for virtual terminal.
	}

	moveBy(lines: number): void {
		if (lines > 0) engineWrite(this.#state, `\x1b[${lines}B`);
		else if (lines < 0) engineWrite(this.#state, `\x1b[${-lines}A`);
	}

	hideCursor(): void {
		engineWrite(this.#state, "\x1b[?25l");
	}

	showCursor(): void {
		engineWrite(this.#state, "\x1b[?25h");
	}

	clearLine(): void {
		engineWrite(this.#state, "\x1b[K");
	}

	clearFromCursor(): void {
		engineWrite(this.#state, "\x1b[J");
	}

	clearScreen(): void {
		engineWrite(this.#state, "\x1b[H\x1b[0J");
	}

	setTitle(title: string): void {
		engineWrite(this.#state, `\x1b]0;${title}\x07`);
	}

	setProgress(active: boolean): void {
		engineWrite(this.#state, active ? "\x1b]9;4;3\x07" : "\x1b]9;4;0;\x07");
	}

	/** How many times the Ghostty instance has been rebuilt. See `#engineRebuilds`. */
	get engineRebuilds(): number {
		return this.#state.engineRebuilds;
	}

	resize(columns: number, rows: number): void {
		const wasBottom = isAtBottom(this.#state);
		this.#state.columns = columns;
		this.#state.rows = rows;
		if (this.#resizeHandler) {
			this.#state.pendingEngineResize = true;
		} else {
			this.#state.term.resize(columns, rows);
			this.#state.historyTextCache.length = 0; // engine rewraps scrollback on resize
			refollowBottom(this.#state, wasBottom);
		}
		this.#resizeHandler?.();
	}

	/** Return whether the virtual viewport is at the scrollback tail. */
	isNativeViewportAtBottom(): boolean | undefined {
		return isAtBottom(this.#state);
	}

	// --- Test-only helpers ---------------------------------------------------

	/** Wait for TUI's throttled render pipeline to settle (matches the ~33ms frame budget). */
	async waitForRender(): Promise<void> {
		const nextTick = Promise.withResolvers<void>();
		process.nextTick(nextTick.resolve);
		await nextTick.promise;
		await Bun.sleep(40);
		await this.flush();
	}

	/** Simulate keyboard input. */
	sendInput(data: string): void {
		this.#inputHandler?.(data);
	}

	/**
	 * Simulate the user scrolling through native terminal scrollback.
	 * Negative values scroll up; positive values scroll down.
	 */
	scrollLines(lines: number): void {
		const capped = cappedBaseY(this.#state.term, this.#state.scrollbackCap);
		this.#state.viewportY = Math.max(0, Math.min(capped, this.#state.viewportY + lines));
	}

	/** Get the terminal buffer's scrollback and viewport offsets. */
	getBufferPosition(): { baseY: number; viewportY: number } {
		return { baseY: cappedBaseY(this.#state.term, this.#state.scrollbackCap), viewportY: this.#state.viewportY };
	}

	/** ghostty.write is synchronous; nothing to drain. Yield a microtask for ordering. */
	async flush(): Promise<void> {
		await Promise.resolve();
	}

	/** Flush and get viewport - convenience method for tests. */
	async flushAndGetViewport(): Promise<string[]> {
		await this.flush();
		return this.getViewport();
	}

	/** Get the visible viewport (what's currently on screen). */
	getViewport(): string[] {
		this.#state.term.update();
		const active = this.#state.term.getViewport();
		const capped = cappedBaseY(this.#state.term, this.#state.scrollbackCap);
		const historyLen = this.#state.term.getScrollbackLength();
		const lines: string[] = [];
		for (let i = 0; i < this.#state.rows; i++) {
			const index = this.#state.viewportY + i;
			lines.push(
				index < capped
					? historyRowText(this.#state.term, this.#state.historyTextCache, historyLen - capped + index)
					: activeRowText(this.#state.term, active, index - capped, this.#state.columns),
			);
		}
		return lines;
	}

	/** Get the entire scroll buffer (clamped scrollback history followed by the active grid). */
	getScrollBuffer(): string[] {
		this.#state.term.update();
		const active = this.#state.term.getViewport();
		const capped = cappedBaseY(this.#state.term, this.#state.scrollbackCap);
		const historyLen = this.#state.term.getScrollbackLength();
		const lines: string[] = [];
		const total = capped + this.#state.rows;
		for (let i = 0; i < total; i++) {
			lines.push(
				i < capped
					? historyRowText(this.#state.term, this.#state.historyTextCache, historyLen - capped + i)
					: activeRowText(this.#state.term, active, i - capped, this.#state.columns),
			);
		}
		return lines;
	}

	/**
	 * Columns in a viewport row whose cells carry a non-default background color.
	 * Used by the SGR-bleed oracle: background attributes must appear only on
	 * rows whose logical content carries background SGR — BCE (back-color-erase)
	 * makes `\x1b[K`/`\x1b[2K` fill erased cells with the *current* background,
	 * so leaked SGR state paints whole phantom-colored rows.
	 */
	getViewportRowBackgroundColumns(row: number): number[] {
		const cells = presentedRowCells(
			this.#state.term,
			this.#state.viewportY,
			row,
			this.#state.rows,
			this.#state.scrollbackCap,
		);
		if (!cells) return [];
		const columns: number[] = [];
		for (let col = 0; col < cells.length; col++) {
			const cell = cells[col];
			if (cell && !isDefaultBg(cell)) columns.push(col);
		}
		return columns;
	}

	/**
	 * Columns in a viewport row whose cells carry a non-default foreground color.
	 * Used with unreset-SGR regressions to ensure per-line resets confine
	 * foreground attributes to the row that emitted them.
	 */
	getViewportRowForegroundColumns(row: number): number[] {
		const cells = presentedRowCells(
			this.#state.term,
			this.#state.viewportY,
			row,
			this.#state.rows,
			this.#state.scrollbackCap,
		);
		if (!cells) return [];
		const columns: number[] = [];
		for (let col = 0; col < cells.length; col++) {
			const cell = cells[col];
			if (cell && !isDefaultFg(cell)) columns.push(col);
		}
		return columns;
	}

	/**
	 * Columns in a viewport row whose cells carry underline.
	 * Used with unreset-SGR regressions to ensure style attributes do not bleed
	 * into later rows or erased blanks.
	 */
	getViewportRowUnderlineColumns(row: number): number[] {
		const cells = presentedRowCells(
			this.#state.term,
			this.#state.viewportY,
			row,
			this.#state.rows,
			this.#state.scrollbackCap,
		);
		if (!cells) return [];
		const columns: number[] = [];
		for (let col = 0; col < cells.length; col++) {
			if ((cells[col]?.flags ?? 0) & CellFlags.UNDERLINE) columns.push(col);
		}
		return columns;
	}

	/**
	 * Columns in a viewport row whose cells carry the faint (dim) attribute.
	 * Lets a test assert what the terminal actually PRESENTS rather than what the
	 * engine emitted: dim is the scroll track's groove, and a byte assertion alone
	 * would still pass if a later reset in the same row cancelled it.
	 */
	getViewportRowFaintColumns(row: number): number[] {
		const cells = presentedRowCells(
			this.#state.term,
			this.#state.viewportY,
			row,
			this.#state.rows,
			this.#state.scrollbackCap,
		);
		if (!cells) return [];
		const columns: number[] = [];
		for (let col = 0; col < cells.length; col++) {
			if ((cells[col]?.flags ?? 0) & CellFlags.FAINT) columns.push(col);
		}
		return columns;
	}

	/** Whether the cell at a viewport position carries the italic attribute. */
	getCellItalic(row: number, col: number): boolean {
		const cells = presentedRowCells(
			this.#state.term,
			this.#state.viewportY,
			row,
			this.#state.rows,
			this.#state.scrollbackCap,
		);
		return ((cells?.[col]?.flags ?? 0) & CellFlags.ITALIC) !== 0;
	}

	/**
	 * Get the hardware cursor position within the visible viewport.
	 * Both coordinates are 0-indexed; row is relative to the top of the active grid.
	 */
	getCursor(): { row: number; col: number } {
		const cursor = this.#state.term.getCursor();
		return { row: cursor.y, col: cursor.x };
	}

	/** Clear the buffer to a blank slate (recreates the engine terminal). */
	clear(): void {
		recreateEngine(this.#state);
	}

	/** Reset the terminal completely (recreates the engine terminal). */
	reset(): void {
		recreateEngine(this.#state);
	}
}
