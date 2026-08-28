/**
 * Pointer routing for the pinned footer: where the footer sits on screen, and
 * which root child a click inside it belongs to.
 *
 * Split out of `tui.ts`. These are positional functions over the compose
 * ledger — they write nothing and request no render; the engine decides that
 * from the boolean they return.
 */
import { clampLow } from "@veyyon/utils/math";
import type { MouseRoutable, SgrMouseEvent } from "@veyyon/utils/mouse";
import type { Component, FrameSegment } from "./component-types";

/** Screen geometry the footer bounds are derived from. */
export interface FooterGeometry {
	/** Scroll-space row frozen at the top of the transcript region, or null while following the tail. */
	virtualScrollTop: number | null;
	terminalRows: number;
	pinnedFooterRows: number;
	composedFrameRows: number;
	windowTopRow: number;
}

export interface PinnedFooterBounds {
	footerTop: number;
	footerBottom: number;
	footerRowOffset: number;
	contentBottom: number;
}

/** True while a pinned-footer child has click targets on screen.
 *
 * Scroll isolation is not the only reason to hold the mouse: the composer
 * chips are click targets whose whole session may never overflow the
 * viewport, and without the grab the terminal reports nothing and the chip
 * is inert text. The want is per frame — the ledger is re-read after every
 * compose — so the grab lasts exactly as long as the targets do. */
export function footerWantsPointer(segments: readonly FrameSegment[], pinnedFooterChildCount: number): boolean {
	if (pinnedFooterChildCount <= 0 || segments.length === 0) return false;
	const first = Math.max(0, segments.length - pinnedFooterChildCount);
	for (let i = first; i < segments.length; i++) {
		const component = segments[i]!.component as Component & Partial<MouseRoutable>;
		if (component.wantsPointer?.() === true) return true;
	}
	return false;
}

/** Wheel step for scroll isolation: freeze/walk the transcript region.
 * Anchored to the live window top so the first wheel-up starts from the
 * currently visible tail; walking down to the tail resumes following. */
export function pinnedFooterScreenBounds(geometry: FooterGeometry): PinnedFooterBounds {
	if (geometry.virtualScrollTop !== null) {
		const height = Math.max(1, geometry.terminalRows);
		const footerRows = Math.min(geometry.pinnedFooterRows, height - 1);
		const footerTop = height - footerRows;
		return {
			footerTop,
			footerBottom: height - 1,
			contentBottom: height - 1,
			footerRowOffset: height - geometry.pinnedFooterRows,
		};
	}
	const frameLength = geometry.composedFrameRows;
	const windowTop = geometry.windowTopRow;
	const footerTop = frameLength - geometry.pinnedFooterRows - windowTop;
	const footerBottom = frameLength - 1 - windowTop;
	return {
		footerTop,
		footerBottom,
		contentBottom: footerBottom,
		footerRowOffset: footerTop,
	};
}

/**
 * Route a pinned-footer click to the root child under it. `footerRow` is
 * 0-based from the footer's top screen row. The footer always shows the
 * LAST #pinnedFooterRows rows of the composed frame (both when following
 * the live tail with a full frame and during virtual scroll), so the
 * clicked frame row is `totalFrameRows - pinnedFooterRows + footerRow`;
 * the segment ledger then resolves it to a component and a local line.
 * Components opt in by implementing MouseRoutable; everyone else keeps
 * ignoring clicks exactly as before.
 */
export function routeFooterMouse(
	segments: readonly FrameSegment[],
	pinnedFooterRows: number,
	pinnedFooterChildCount: number,
	event: SgrMouseEvent,
	footerRow: number,
): boolean {
	if (segments.length === 0) return false;
	const last = segments[segments.length - 1]!;
	const totalFrameRows = last.start + last.rowCount;
	const frameRow = totalFrameRows - pinnedFooterRows + footerRow;
	const firstFooterIndex = Math.max(0, segments.length - pinnedFooterChildCount);
	for (let i = firstFooterIndex; i < segments.length; i++) {
		const segment = segments[i]!;
		if (segment.rowCount <= 0) continue;
		if (frameRow < segment.start || frameRow >= segment.start + segment.rowCount) continue;
		const component = segment.component as Component & Partial<MouseRoutable>;
		if (typeof component.routeMouse === "function") {
			const localRow = clampLow(frameRow - segment.start, 0, segment.rowCount - 1);
			component.routeMouse(event, localRow, event.col);
			return true;
		}
		return false;
	}
	return false;
}
