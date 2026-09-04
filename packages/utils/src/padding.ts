/**
 * Space runs and the two ways a line is fitted to a column count: centered, or
 * padded out to exactly `width`. No terminal I/O.
 */

import { truncateToWidth, visibleWidth } from "./width";

// Pre-allocated space buffer for padding
const SPACE_BUFFER = " ".repeat(512);
// Upper bound on a single padding run. No terminal is anywhere near this wide;
// the cap exists only to keep `padding` total against an out-of-contract width
// (a bad resize delivering Infinity/NaN, or a computed width in the millions),
// which would otherwise throw in `String.prototype.repeat` (Infinity) or
// allocate multiple gigabytes (a huge finite n) — a render-path crash / DoS.
const MAX_PADDING = 1 << 20; // 1,048,576

/**
 * Returns a string of n spaces. Uses a pre-allocated buffer for efficiency.
 */
export function padding(n: number): string {
	// `!(n >= 1)` rejects n <= 0, NaN, and -Infinity in one check.
	if (!(n >= 1)) return "";
	if (n <= 512) return SPACE_BUFFER.slice(0, n);
	return " ".repeat(n > MAX_PADDING ? MAX_PADDING : n);
}

/** Horizontally center `line` in `width` cells; truncates when the line is wider. */
export function centerLine(line: string, width: number): string {
	const lineWidth = visibleWidth(line);
	if (lineWidth >= width) return truncateToWidth(line, width);
	const left = Math.floor((width - lineWidth) / 2);
	return padding(left) + line + padding(width - left - lineWidth);
}

/**
 * Fit a line to exactly `width` visible columns: truncate what overflows, then
 * pad the remainder with spaces. Truncation on a wide-character boundary can
 * leave `width - 1` visible columns, so the trailing pad is computed from the
 * truncated line's real width to guarantee the result is always exactly `width`.
 */
export function padLineToWidth(line: string, width: number): string {
	const truncated = truncateToWidth(line, width);
	return truncated + padding(width - visibleWidth(truncated));
}
