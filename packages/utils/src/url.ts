/**
 * URL string primitives shared by provider/discovery base-URL normalizers.
 * Each caller keeps its own default/env/suffix policy; the slash handling
 * lives here so "http://x//" cannot normalize differently across providers.
 */

/** Strip every trailing slash — `"http://x//"` → `"http://x"`. */
export function trimTrailingSlashes(value: string): string {
	return value.replace(/\/+$/, "");
}

/**
 * Normalize a provider/discovery base URL: trim surrounding whitespace and
 * strip trailing slashes so `"http://x/ "` and `"http://x"` compare equal.
 *
 * When the input is missing or blank, `fallback` is returned unchanged — pass a
 * default URL to substitute one, `""` to signal "no base URL" as an empty
 * string, or omit it to get `undefined`. The fallback is returned as-is, so a
 * default constant you pass in must already be free of trailing slashes.
 *
 * Env/default *resolution* policy stays with each caller (which env var, which
 * default); this owner only fixes the trim + slash handling so it cannot drift
 * between providers.
 */
export function normalizeBaseUrl(baseUrl: string | undefined, fallback: string): string;
export function normalizeBaseUrl(baseUrl: string | undefined, fallback?: undefined): string | undefined;
export function normalizeBaseUrl(baseUrl: string | undefined, fallback?: string): string | undefined {
	const trimmed = baseUrl?.trim();
	if (trimmed) return trimTrailingSlashes(trimmed);
	return fallback;
}
