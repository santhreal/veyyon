import { clamp } from "../utils";

/**
 * Spacer component that renders empty lines
 */
/** Coerce requested line count to a valid non-negative integer. */
export function normalizeLineCount(lines: number): number {
	if (!Number.isFinite(lines)) return 0;
	return clamp(Math.trunc(lines), 0, MAX_SPACER_LINES);
}

// Far above any real layout; a spacer taller than this is a caller bug, not a
// legitimate request, and reserving it would waste memory in the render tree.
export const MAX_SPACER_LINES = 1 << 16;
