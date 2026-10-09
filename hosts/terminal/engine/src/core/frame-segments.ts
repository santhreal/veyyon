/**
 * Arithmetic over the segments a composed frame is made of: one `FrameSegment` per root child of
 * the `TUI`. The compose pass derives each segment's live region and unchanged rows from these, the
 * scroll-isolation footer is measured over them, and a component-scoped frame or a direct write
 * selects the segments it touches with them. Split out of `tui.ts`; none of it reads engine state.
 */
import { clampLow } from "@veyyon/utils/math";
import { type Component, type FrameSegment, getNativeScrollbackLiveRegionStart } from "./component-types";

/** Where a freshly rendered root child's live region starts among its `rowCount` rows; undefined when it reports none. */
export function liveRegionLocalStart(child: Component, rowCount: number): number | undefined {
	const liveRegionStart = getNativeScrollbackLiveRegionStart(child);
	if (liveRegionStart === undefined) return undefined;
	return Number.isFinite(liveRegionStart) ? clampLow(Math.trunc(liveRegionStart), 0, rowCount) : rowCount;
}

/**
 * Leading rows of a root child's composed `lines` unchanged since the previous compose, given the previous frame's
 * segment in the same slot. A child's stable-prefix report (`reported`) overrides reference equality, and rows
 * beyond the previous row count cannot be "unchanged". Undefined when the slot held another child or the segment
 * moved.
 */
export function unchangedSegmentRows(
	previous: FrameSegment | undefined,
	child: Component,
	start: number,
	lines: readonly string[],
	reported: number | undefined,
): number | undefined {
	if (previous === undefined || previous.component !== child || previous.start !== start) return undefined;
	if (reported !== undefined) {
		return Number.isFinite(reported)
			? Math.max(0, Math.min(lines.length, previous.rowCount, Math.trunc(reported)))
			: 0;
	}
	return previous.lines === lines ? lines.length : 0;
}

/** Frame rows spanned by the last `pinnedChildCount` root children, which scroll isolation pins as the footer. */
export function pinnedFooterRows(
	segments: readonly FrameSegment[],
	frameRows: number,
	pinnedChildCount: number,
): number {
	if (pinnedChildCount <= 0 || segments.length < pinnedChildCount) return 0;
	return frameRows - segments[segments.length - pinnedChildCount]!.start;
}

/**
 * A segment may be rewritten in place only when none of it is committed to native scrollback and it holds no live
 * region, or is live from its first row.
 */
export function segmentAcceptsDirectWrite(segment: FrameSegment, committedRows: number): boolean {
	if (segment.start < committedRows) return false;
	return segment.liveLocalStart === undefined || segment.liveLocalStart === 0;
}

/** A root child's re-rendered rows, checked to fit its segment and screen position unchanged. */
export interface DirectWrite {
	segmentIndex: number;
	segment: FrameSegment;
	nextLines: readonly string[];
	/** Frame row the visible window starts at. */
	windowTop: number;
	/** Screen row the segment starts at. */
	screenStart: number;
	width: number;
	height: number;
}

/**
 * Record that `root` re-renders for a target reached through its direct child `via`; an undefined `via` (the target
 * is the root) re-renders all of it, recorded as null.
 */
export function addScopedChild(
	scoped: Map<Component, Set<Component> | null>,
	root: Component,
	via: Component | undefined,
): void {
	if (via === undefined) {
		scoped.set(root, null);
		return;
	}
	const children = scoped.get(root);
	if (children === undefined) scoped.set(root, new Set([via]));
	else if (children !== null) children.add(via);
}
