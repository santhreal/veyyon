/**
 * The records one frame's render phases pass between them. `TUI#doRender` captures the
 * transition, reconciles the committed prefix, plans the window, assembles its rows and selects
 * an intent (`render-intent.ts`); each record is the output of one phase and the input of the next.
 */

/**
 * Window and cursor state `#doRender` captures before any emitter runs, and
 * whether the frame changed the terminal geometry.
 */
export interface FrameTransition {
	/** Frame row the window started at after the previous frame. */
	readonly prevWindowTop: number;
	/** Frame row the hardware cursor was tracked at after the previous frame. */
	readonly prevHardwareCursorRow: number;
	/** The width or height changed, or a resize event reflowed the buffer at the same size. */
	readonly geometryChanged: boolean;
}

/**
 * What the committed-prefix audit and the collapse rebase settled for one
 * frame, and the commit ledger the frame's commit math extends from.
 */
export interface PrefixReconciliation {
	/** The audit scanned the verified rows and the rows that newly became final. */
	readonly auditRan: boolean;
	/** The commit index moved back because the frame disagrees with the committed record. */
	readonly committedRowsResynced: boolean;
	/** The frame is a strict, byte-identical prefix of the committed record: the viewport squeezed it. */
	readonly frameSqueezed: boolean;
	/** `#committedRows` after reconciliation, before any emitter runs. */
	readonly preCommitRows: number;
	/** `#committedPrefixAuditRows` after reconciliation, before any emitter runs. */
	readonly preAuditRows: number;
}

/** Where one frame's window sits and how far its commit reaches. */
export interface WindowPlan {
	/** Frame row the visible window starts at. */
	readonly windowTop: number;
	/** End of the rows this frame commits to native scrollback, `[#committedRows, chunkTo)`. */
	readonly chunkTo: number;
	/** The committed prefix was rebuilt from this frame, so the audit mark re-bases outright. */
	readonly committedPrefixResliced: boolean;
	/** The transcript region shows the frozen scroll-isolation slice. */
	readonly virtualScrollSlice: boolean;
}

/** The rows one frame puts on screen and where its caret lands. */
export interface AssembledWindow {
	/** The composed frame prepared for emission, row-aligned with the raw frame. */
	readonly frame: readonly string[];
	/** The viewport rows, overlays composited. */
	readonly window: string[];
	/** Frame-space caret for the normal-screen emitters; null when none is visible. */
	readonly cursorPos: { row: number; col: number } | null;
	/** Screen-space caret for a resident alt-buffer paint; null when none is visible. */
	readonly altCaret: { row: number; col: number } | null;
	/** Line count the hardware-cursor tracker measures the caret against. */
	readonly cursorTrackingLineCount: number;
	/** The window is an overlay composite or the frozen scroll-isolation view, so an update rewrites it in place. */
	readonly repaintInPlace: boolean;
}

/** The positions one incremental update writes relative to, derived from the plan and the previous frame. */
export interface UpdateGeometry {
	/** First frame row of the commit chunk: `#committedRows` before the update. */
	readonly chunkFrom: number;
	/** End of the commit chunk, `[chunkFrom, chunkTo)`. */
	readonly chunkTo: number;
	/** Frame row the window starts at. */
	readonly windowTop: number;
	/** Rows the window moved down since the previous frame. */
	readonly scroll: number;
	/** Screen row the hardware cursor is on before the update, clamped to the viewport. */
	readonly currentScreenRow: number;
	/** Frame row of the last content row inside the window. */
	readonly contentBottomRow: number;
	/** Bytes every update opens with: the paint-begin sequence, then the image purge. */
	readonly lead: string;
	readonly width: number;
	readonly height: number;
}
