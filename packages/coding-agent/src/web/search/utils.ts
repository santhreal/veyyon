/** Calculate age in seconds from an ISO date string. Returns undefined on invalid input. */
export function dateToAgeSeconds(dateStr: string | null | undefined): number | undefined {
	if (!dateStr) return undefined;
	try {
		const date = new Date(dateStr);
		if (Number.isNaN(date.getTime())) return undefined;
		return Math.floor((Date.now() - date.getTime()) / 1000);
	} catch {
		return undefined;
	}
}

/** Clamp a result count to [1, maxVal], returning defaultVal when value is absent or NaN. */
export function clampNumResults(value: number | undefined, defaultVal: number, maxVal: number): number {
	if (!value || Number.isNaN(value)) return defaultVal;
	return Math.min(maxVal, Math.max(1, value));
}

/**
 * Collapse every run of whitespace (spaces, tabs, newlines) to a single space
 * and trim the ends. The canonical cleanup for text scraped out of provider
 * result HTML, where markup indentation and line wraps leak into the extracted
 * text. `null`/`undefined` normalize to "". Single owner for the HTML-scraping
 * search providers (google, startpage, mojeek, ecosia, …) — do not re-inline
 * `(x ?? "").replace(/\s+/g, " ").trim()`.
 */
export function collapseWhitespace(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}
