/**
 * Formatting helpers for values that go into a log line or a warning.
 *
 * These are the one home for the truncation idioms mnemopi uses when it writes
 * an untrusted or oversized value into a diagnostic. Keeping them here stops the
 * same slice-and-mark expression from being pasted at each call site.
 */

/**
 * Cap a string for a log line. When `value` is longer than `maxLen` it is cut to
 * the first `maxLen` characters and a `...[truncated]` marker is appended, so the
 * reader can tell the line was clipped. Shorter values pass through unchanged.
 *
 * This is deliberately distinct from `truncate` in `@veyyon/utils`: that keeps
 * the total length at or under `maxLen` and uses a single `…` ellipsis, while
 * this keeps exactly `maxLen` characters of the original and marks the cut
 * explicitly. Use `truncate` for display width, this for diagnostic strings.
 */
export function truncateForLog(value: string, maxLen: number): string {
	return value.length > maxLen ? `${value.slice(0, maxLen)}...[truncated]` : value;
}
