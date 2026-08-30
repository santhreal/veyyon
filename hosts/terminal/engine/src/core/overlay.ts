/**
 * The overlay stack: what is painted on top of the frame, and where.
 *
 * An overlay never enters the frame. It is composited into the painted WINDOW after the frame is
 * composed, and commits to native scrollback are frozen while one is visible, so an overlay's cells
 * cannot reach the terminal's scrollback record. That is why positioning, clipping and compositing
 * all live here rather than in the renderer: they operate on the window slice, after the frame the
 * renderer owns is already decided.
 *
 * Painting and interaction diverge for exactly the length of an exit animation. A card that is
 * playing itself out is still painted and is already gone as far as focus, the keyboard and
 * `hasInteractive()` are concerned; `isVisible` and `isInteractive` are the two separate answers.
 */
import { SGR_RESET } from "@veyyon/utils/ansi";
import { clampLow } from "@veyyon/utils/math";
import { extractSegments, sliceByColumn, sliceWithWidth, visibleWidth } from "@veyyon/utils/width";
import { TERMINAL } from "../terminal-capabilities";
import type { Component } from "./component-types";

// Scroll position, drawn on the right edge of a frozen transcript region. The
// groove is dimmed rather than coloured: the engine owns no palette (themes
// live in the host), and dim reads as chrome against every ground.
const SCROLL_TRACK_GROOVE = "\x1b[2m│\x1b[22m";
const SCROLL_TRACK_THUMB = "█";

/**
 * Anchor position for overlays
 */
export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

/**
 * Margin configuration for overlays
 */
export interface OverlayMargin {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

/** Value that can be absolute (number) or percentage (string like "50%") */
export type SizeValue = number | `${number}%`;

/** Parse a SizeValue into absolute value given a reference size */
function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	// Parse percentage string like "50%"
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

/**
 * Options for overlay positioning and sizing.
 * Values can be absolute numbers or percentage strings (e.g., "50%").
 */
export interface OverlayOptions {
	// === Sizing ===
	/** Width in columns, or percentage of terminal width (e.g., "50%") */
	width?: SizeValue;
	/** Minimum width in columns */
	minWidth?: number;
	/** Maximum height in rows, or percentage of terminal height (e.g., "50%") */
	maxHeight?: SizeValue;

	// === Positioning - anchor-based ===
	/** Anchor point for positioning (default: 'center') */
	anchor?: OverlayAnchor;
	/** Horizontal offset from anchor position (positive = right) */
	offsetX?: number;
	/** Vertical offset from anchor position (positive = down) */
	offsetY?: number;

	// === Positioning - percentage or absolute ===
	/** Row position: absolute number, or percentage (e.g., "25%" = 25% from top) */
	row?: SizeValue;
	/** Column position: absolute number, or percentage (e.g., "50%" = centered horizontally) */
	col?: SizeValue;

	// === Margin from terminal edges ===
	/** Margin from terminal edges. Number applies to all sides. */
	margin?: OverlayMargin | number;

	// === Visibility ===
	/**
	 * Control overlay visibility based on terminal dimensions.
	 * If provided, overlay is only rendered when this returns true.
	 * Called each render cycle with current terminal dimensions.
	 */
	visible?: (termWidth: number, termHeight: number) => boolean;

	// === Fullscreen ===
	/**
	 * Borrow the terminal's alternate screen buffer for this overlay's lifetime
	 * (vim/less idiom). While the topmost visible overlay sets this, the engine
	 * paints only the modal on the alt screen and emits no ED3 / scrollback
	 * bytes, so the transcript on the normal screen stays untouched and is not
	 * scrollable behind the modal. Defaults off — all other overlays are
	 * unchanged and still draw over the transcript on the normal screen.
	 */
	fullscreen?: boolean;
}

/**
 * Handle returned by showOverlay for controlling the overlay
 */
export interface OverlayHandle {
	/** Permanently remove the overlay (cannot be shown again) */
	hide(): void;
	/** Temporarily hide or show the overlay */
	setHidden(hidden: boolean): void;
	/** Check if overlay is temporarily hidden */
	isHidden(): boolean;
}

/**
 * An overlay that would rather fade out than vanish.
 *
 * `hide()` asks the component for an exit before removing it. Answering `true` means the component
 * has taken a repaint callback and will call `done` when its last frame is drawn; the host keeps
 * painting it until then and stops routing input to it at once. Answering `false`, or not
 * implementing this at all, removes the overlay the way it always has.
 *
 * The capability lives here rather than in a modal base class because the overlay STACK is what
 * has to keep the card alive: a component cannot outlive the host's decision to drop it.
 */
export interface OverlayExitAnimatable {
	beginOverlayExit(requestRender: () => void, done: () => void): boolean;
}

/** Whether `component` can play itself out. */
export function canAnimateOverlayExit(component: Component): component is Component & OverlayExitAnimatable {
	return typeof (component as Partial<OverlayExitAnimatable>).beginOverlayExit === "function";
}

/** One card on the stack, with the focus it took and whether it is still interactive. */
export interface OverlayEntry {
	component: Component;
	options?: OverlayOptions;
	preFocus: Component | null;
	hidden: boolean;
	/**
	 * The card is playing itself out: still PAINTED, no longer INTERACTIVE. Focus has already
	 * gone back to whatever the overlay took it from, so the transcript answers a keystroke
	 * during the fade rather than a card the operator has already dismissed.
	 */
	exiting: boolean;
}

/** The terminal geometry an overlay's `visible` predicate is asked about. */
export interface OverlayViewport {
	readonly columns: number;
	readonly rows: number;
}

/**
 * Resolve overlay layout from options.
 * Returns { width, row, col, maxHeight } for rendering.
 */
export function resolveOverlayLayout(
	options: OverlayOptions | undefined,
	overlayHeight: number,
	termWidth: number,
	termHeight: number,
): { width: number; row: number; col: number; maxHeight: number } {
	const opt = options ?? {};

	// Parse margin (clamp to non-negative)
	const margin =
		typeof opt.margin === "number"
			? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
			: (opt.margin ?? {});
	const marginTop = Math.max(0, margin.top ?? 0);
	const marginRight = Math.max(0, margin.right ?? 0);
	const marginBottom = Math.max(0, margin.bottom ?? 0);
	const marginLeft = Math.max(0, margin.left ?? 0);

	// Available space after margins
	const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
	const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

	// === Resolve width ===
	let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
	// Apply minWidth
	if (opt.minWidth !== undefined) {
		width = Math.max(width, opt.minWidth);
	}
	// Clamp to available space
	width = clampLow(width, 1, availWidth);

	// === Resolve maxHeight ===
	let maxHeight = parseSizeValue(opt.maxHeight, termHeight) ?? availHeight;
	maxHeight = clampLow(maxHeight, 1, availHeight);

	// Effective overlay height: maxHeight is always resolved (defaults to
	// availHeight above), so the overlay is unconditionally clamped to fit.
	const effectiveHeight = Math.min(overlayHeight, maxHeight);

	// === Resolve position ===
	let row: number;
	let col: number;

	if (opt.row !== undefined) {
		if (typeof opt.row === "string") {
			// Percentage: 0% = top, 100% = bottom (overlay stays within bounds)
			const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
			if (match) {
				const maxRow = Math.max(0, availHeight - effectiveHeight);
				const percent = parseFloat(match[1]) / 100;
				row = marginTop + Math.floor(maxRow * percent);
			} else {
				// Invalid format, fall back to center
				row = resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
			}
		} else {
			// Absolute row position
			row = opt.row;
		}
	} else {
		// Anchor-based (default: center)
		const anchor = opt.anchor ?? "center";
		row = resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
	}

	if (opt.col !== undefined) {
		if (typeof opt.col === "string") {
			// Percentage: 0% = left, 100% = right (overlay stays within bounds)
			const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
			if (match) {
				const maxCol = Math.max(0, availWidth - width);
				const percent = parseFloat(match[1]) / 100;
				col = marginLeft + Math.floor(maxCol * percent);
			} else {
				// Invalid format, fall back to center
				col = resolveAnchorCol("center", width, availWidth, marginLeft);
			}
		} else {
			// Absolute column position
			col = opt.col;
		}
	} else {
		// Anchor-based (default: center)
		const anchor = opt.anchor ?? "center";
		col = resolveAnchorCol(anchor, width, availWidth, marginLeft);
	}

	// Apply offsets
	if (opt.offsetY !== undefined) row += opt.offsetY;
	if (opt.offsetX !== undefined) col += opt.offsetX;

	// Clamp to terminal bounds (respecting margins)
	row = clampLow(row, marginTop, termHeight - marginBottom - effectiveHeight);
	col = clampLow(col, marginLeft, termWidth - marginRight - width);

	return { width, row, col, maxHeight };
}

function resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
	switch (anchor) {
		case "top-left":
		case "top-center":
		case "top-right":
			return marginTop;
		case "bottom-left":
		case "bottom-center":
		case "bottom-right":
			return marginTop + availHeight - height;
		case "left-center":
		case "center":
		case "right-center":
			return marginTop + Math.floor((availHeight - height) / 2);
	}
}

function resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
	switch (anchor) {
		case "top-left":
		case "left-center":
		case "bottom-left":
			return marginLeft;
		case "top-right":
		case "right-center":
		case "bottom-right":
			return marginLeft + availWidth - width;
		case "top-center":
		case "center":
		case "bottom-center":
			return marginLeft + Math.floor((availWidth - width) / 2);
	}
}

/** Splice overlay content into a base line at a specific column. Single-pass optimized. */
export function compositeLineAt(
	baseLine: string,
	overlayLine: string,
	startCol: number,
	overlayWidth: number,
	totalWidth: number,
): string {
	if (TERMINAL.isImageLine(baseLine)) return baseLine;

	// Single pass through baseLine extracts both before and after segments
	const afterStart = startCol + overlayWidth;
	const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);

	// Extract overlay with width tracking (strict=true to exclude wide chars at boundary)
	const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);

	// Pad segments to target widths
	const beforePad = Math.max(0, startCol - base.beforeWidth);
	const overlayPad = Math.max(0, overlayWidth - overlay.width);
	const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
	const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
	const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
	const afterPad = Math.max(0, afterTarget - base.afterWidth);

	// Compose result
	const r = SGR_RESET;
	const result =
		base.before +
		" ".repeat(beforePad) +
		r +
		overlay.text +
		" ".repeat(overlayPad) +
		r +
		base.after +
		" ".repeat(afterPad);

	// CRITICAL: Always verify and truncate to terminal width.
	// This is the final safeguard against width overflow which would crash the TUI.
	// Width tracking can drift from actual visible width due to:
	// - Complex ANSI/OSC sequences (hyperlinks, colors)
	// - Wide characters at segment boundaries
	// - Edge cases in segment extraction
	const resultWidth = visibleWidth(result);
	if (resultWidth <= totalWidth) {
		return result;
	}
	// Truncate with strict=true to ensure we don't exceed totalWidth
	return sliceByColumn(result, 0, totalWidth, true);
}

/**
 * Draw the scroll position on the right edge of the frozen transcript
 * region: a dim one-column track with a bright thumb, the placement
 * opencode uses. It lives in the region that actually moved, so the pinned
 * footer renders byte-identically whether the view is frozen or following —
 * the composer's own rows never become a scroll readout.
 *
 * Mutates `window` in place through the same cell-accurate compositor
 * overlays use, so a row's styling and any wide glyphs survive.
 */
export function drawScrollTrack(
	window: string[],
	regionRows: number,
	viewTop: number,
	spaceRows: number,
	width: number,
): void {
	if (width < 4 || regionRows < 2 || spaceRows <= regionRows) return;
	const col = width - 1;
	const thumbRows = clampLow(Math.round((regionRows * regionRows) / spaceRows), 1, regionRows);
	const travel = regionRows - thumbRows;
	const scrollable = spaceRows - regionRows;
	const thumbTop = travel <= 0 ? 0 : clampLow(Math.round((viewTop / scrollable) * travel), 0, travel);
	for (let r = 0; r < regionRows; r++) {
		const inThumb = r >= thumbTop && r < thumbTop + thumbRows;
		const cell = inThumb ? SCROLL_TRACK_THUMB : SCROLL_TRACK_GROOVE;
		window[r] = compositeLineAt(window[r] ?? "", cell, col, 1, width);
	}
}

/**
 * The stack itself. It owns the entries, the two visibility answers and the composite; the engine
 * asks it questions and never walks the array.
 */
export class OverlayStack {
	#entries: OverlayEntry[] = [];
	readonly #viewport: OverlayViewport;

	constructor(viewport: OverlayViewport) {
		this.#viewport = viewport;
	}

	/** Every entry, bottom-most first. Read-only: mutate through `push` and `remove`. */
	get entries(): readonly OverlayEntry[] {
		return this.#entries;
	}

	get size(): number {
		return this.#entries.length;
	}

	push(entry: OverlayEntry): void {
		this.#entries.push(entry);
	}

	/** Drop `entry`. Returns whether it was still on the stack, which is how a second `hide()` is a no-op. */
	remove(entry: OverlayEntry): boolean {
		const index = this.#entries.indexOf(entry);
		if (index === -1) return false;
		this.#entries.splice(index, 1);
		return true;
	}

	holds(entry: OverlayEntry): boolean {
		return this.#entries.indexOf(entry) !== -1;
	}

	/** The components on the stack, bottom-most first, for a focus walk. */
	components(): Component[] {
		return this.#entries.map(entry => entry.component);
	}

	/** Whether an entry is currently PAINTED. An exiting card is: that is the whole point. */
	isVisible(entry: OverlayEntry): boolean {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			return entry.options.visible(this.#viewport.columns, this.#viewport.rows);
		}
		return true;
	}

	/**
	 * Whether an entry can take input and hold focus. Painting and interaction diverge for
	 * exactly the length of an exit: the card is on screen, and it is already gone as far as the
	 * keyboard, the mouse and `hasInteractive()` are concerned.
	 */
	isInteractive(entry: OverlayEntry): boolean {
		return !entry.exiting && this.isVisible(entry);
	}

	/** Whether any overlay can still take input. */
	hasInteractive(): boolean {
		return this.#entries.some(entry => this.isInteractive(entry));
	}

	/** The topmost overlay that is PAINTED, including one that is playing itself out. */
	topmostVisible(): OverlayEntry | undefined {
		for (let i = this.#entries.length - 1; i >= 0; i--) {
			if (this.isVisible(this.#entries[i]!)) return this.#entries[i];
		}
		return undefined;
	}

	/** The topmost overlay that can hold focus, which an exiting card cannot. */
	topmostInteractive(): OverlayEntry | undefined {
		for (let i = this.#entries.length - 1; i >= 0; i--) {
			if (this.isInteractive(this.#entries[i]!)) return this.#entries[i];
		}
		return undefined;
	}

	invalidate(): void {
		for (const entry of this.#entries) entry.component.invalidate?.();
	}

	/**
	 * Composite every visible overlay into the window slice (screen coordinates, in stack order,
	 * later = on top). Overlays never touch the frame: composited rows exist only in the painted
	 * window, and commits are frozen while an overlay is visible, so overlay cells can never enter
	 * native scrollback.
	 */
	compositeIntoWindow(window: string[], termWidth: number, termHeight: number): string[] {
		const result = [...window];
		for (const entry of this.#entries) {
			if (!this.isVisible(entry)) continue;
			const { component, options } = entry;
			// Get layout with height=0 first to determine width and maxHeight
			// (width and maxHeight don't depend on overlay height).
			const { width, maxHeight } = resolveOverlayLayout(options, 0, termWidth, termHeight);
			let overlayLines = component.render(width);
			if (overlayLines.length > maxHeight) {
				const anchor = options?.anchor ?? "center";
				overlayLines =
					anchor === "bottom-left" || anchor === "bottom-center" || anchor === "bottom-right"
						? overlayLines.slice(overlayLines.length - maxHeight)
						: overlayLines.slice(0, maxHeight);
			}
			const { row, col } = resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);
			for (let i = 0; i < overlayLines.length; i++) {
				const idx = row + i;
				if (idx < 0 || idx >= result.length) continue;
				const truncatedOverlayLine =
					visibleWidth(overlayLines[i]) > width ? sliceByColumn(overlayLines[i], 0, width, true) : overlayLines[i];
				result[idx] = compositeLineAt(result[idx], truncatedOverlayLine, col, width, termWidth);
			}
		}
		return result;
	}
}
