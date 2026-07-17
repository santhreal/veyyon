const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Format a duration in milliseconds to a short human-readable string.
 * Examples: "123ms", "1.5s", "30m15s", "2h30m", "3d2h"
 */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0ms";
	if (ms < SEC) return `${ms}ms`;
	if (ms < MIN) return `${(ms / SEC).toFixed(1)}s`;
	if (ms < HOUR) {
		const mins = Math.floor(ms / MIN);
		const secs = Math.floor((ms % MIN) / SEC);
		return secs > 0 ? `${mins}m${secs}s` : `${mins}m`;
	}
	if (ms < DAY) {
		const hours = Math.floor(ms / HOUR);
		const mins = Math.floor((ms % HOUR) / MIN);
		return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
	}
	const days = Math.floor(ms / DAY);
	const hours = Math.floor((ms % DAY) / HOUR);
	return hours > 0 ? `${days}d${hours}h` : `${days}d`;
}

/**
 * Format a number with K/M/B suffix for compact display.
 * Uses 1 decimal for small leading digits when non-zero, rounded otherwise.
 * Examples: "999", "1K", "1.5K", "25K", "1M", "1.5M", "25M", "1.5B"
 */
export function formatNumber(n: number): string {
	if (n < 1_000) return n.toString();
	if (n < 10_000) return `${trim1(n / 1_000)}K`;
	if (n < 1_000_000) return `${Math.round(n / 1_000)}K`;
	if (n < 10_000_000) return `${trim1(n / 1_000_000)}M`;
	if (n < 1_000_000_000) return `${Math.round(n / 1_000_000)}M`;
	if (n < 10_000_000_000) return `${trim1(n / 1_000_000_000)}B`;
	return `${Math.round(n / 1_000_000_000)}B`;
}

/** Format with up to 1 decimal place, dropping trailing `.0`. */
function trim1(n: number): string {
	const s = n.toFixed(1);
	return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/**
 * Format a byte count to a human-readable string.
 * Examples: "512B", "1.5KB", "2.3MB", "1.2GB"
 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

/**
 * Truncate a string to maxLen characters, appending an ellipsis if truncated.
 * For display-width-aware truncation (terminals), use truncateToWidth from @veyyon/pi-tui.
 */
export function truncate(str: string, maxLen: number, ellipsis = "…"): string {
	if (str.length <= maxLen) return str;
	const sliceLen = Math.max(0, maxLen - ellipsis.length);
	return `${str.slice(0, sliceLen)}${ellipsis}`;
}

/**
 * Format count with pluralized label (e.g., "3 files", "1 error").
 */
export function formatCount(label: string, count: number): string {
	const safeCount = Number.isFinite(count) ? count : 0;
	return `${safeCount} ${pluralize(label, safeCount)}`;
}

/**
 * Format age from seconds to human-readable string.
 */
export function formatAge(ageSeconds: number | null | undefined): string {
	if (!ageSeconds) return "";
	const mins = Math.floor(ageSeconds / 60);
	const hours = Math.floor(mins / 60);
	const days = Math.floor(hours / 24);
	const weeks = Math.floor(days / 7);
	const months = Math.floor(days / 30);

	if (months > 0) return `${months}mo ago`;
	if (weeks > 0) return `${weeks}w ago`;
	if (days > 0) return `${days}d ago`;
	if (hours > 0) return `${hours}h ago`;
	if (mins > 0) return `${mins}m ago`;
	return "just now";
}

/**
 * Pluralize a label based on the count.
 */
export function pluralize(label: string, count: number): string {
	if (count === 1) return label;
	if (/(?:ch|sh|s|x|z)$/i.test(label)) return `${label}es`;
	if (/[^aeiou]y$/i.test(label)) return `${label.slice(0, -1)}ies`;
	return `${label}s`;
}

/**
 * Format a ratio as a percentage.
 * Examples: "12.5%", formatPercent(0.125, 0) -> "13%"
 */
export function formatPercent(ratio: number, digits = 1): string {
	return `${(ratio * 100).toFixed(digits)}%`;
}

/**
 * Format a dollar cost with precision scaled to magnitude; an exact zero is
 * "$0". Pass `digits` to pin the fraction digits instead.
 * Examples: "$0", "$0.0042", "$0.123", "$1.25", formatCost(0.5, 2) -> "$0.50"
 */
export function formatCost(n: number, digits?: number): string {
	if (n === 0) return "$0";
	if (digits !== undefined) return `$${n.toFixed(digits)}`;
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

/** Round a premium-request count to 2 decimals (fractional requests are billed in hundredths). */
export function normalizePremiumRequests(n: number): number {
	return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * ASCII kebab slug: lowercase, non-alphanumeric runs collapse to single
 * hyphens, no leading/trailing hyphens; "" when nothing survives. ONE PLACE
 * for branch names, remote names, advisor ids, and usage-limit slugs.
 */
export function kebabSlug(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

const FILENAME_UNSAFE_RE = /[^A-Za-z0-9._-]/g;

/**
 * Make a string safe as a single filesystem path segment: anything outside
 * `A-Za-z0-9._-` becomes `_`. ONE PLACE for runtime cache keys and derived
 * file/dir names.
 */
export function safeFilenameSegment(value: string): string {
	return value.replace(FILENAME_UNSAFE_RE, "_");
}

// Derived from FILENAME_UNSAFE_RE so the charset cannot fork.
const FILENAME_UNSAFE_RUNS_RE = new RegExp(`${FILENAME_UNSAFE_RE.source}+`, "g");

/**
 * Run-collapsing twin of {@link safeFilenameSegment}: each *run* of unsafe
 * characters becomes a single `_` (`"a//b"` → `"a_b"`, not `"a__b"`). ONE
 * PLACE for path-derived artifact slugs and cache segments.
 */
export function safeFilenameSegmentCollapsed(value: string): string {
	return value.replace(FILENAME_UNSAFE_RUNS_RE, "_");
}
