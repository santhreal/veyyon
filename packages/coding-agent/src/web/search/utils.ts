// `collapseWhitespace` now lives in @veyyon/utils as the repo-wide owner of the
// collapse-and-trim idiom; re-exported here so the HTML-scraping providers keep
// importing it from `../utils` unchanged.
export { collapseWhitespace } from "@veyyon/utils";

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
