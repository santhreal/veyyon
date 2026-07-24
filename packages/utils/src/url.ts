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
	// Strip the trailing run of slashes AND any whitespace interleaved with them.
	// The leading `.trim()` removes edge whitespace, but a trailing slash can sit
	// in front of an interior space (`"http://x /"`); stripping only the slash
	// would re-expose that space and emit a base URL that ends in whitespace,
	// breaking every URL join and contradicting this function's own contract
	// ("trim surrounding whitespace AND strip trailing slashes"). Removing the
	// combined `[/\s]+` run in one pass keeps the result fully trimmed and
	// slash-free no matter how slashes and spaces interleave at the end.
	// `trimTrailingSlashes` stays slash-only for its other callers.
	if (trimmed) return trimmed.replace(/[/\s]+$/, "");
	return fallback;
}

/**
 * The RFC 3986 scheme charset, anchored to a leading `scheme://` and capturing
 * the scheme (group 1). This is the ONE owner for "does this string start with
 * a URL scheme" — provider base URLs, internal URIs (`skill://`, `artifact://`),
 * and web URLs all share the same scheme grammar (`ALPHA *( ALPHA / DIGIT / "+"
 * / "-" / "." )`), so hand-copying the literal drifts. Non-global, so `.exec`
 * and `.test` stay stateless.
 *
 * Callers that only need the raw match offsets (e.g. `match[0].length` to find
 * where the scheme ends) may use this const directly; everyone else should
 * prefer {@link hasUrlScheme} or {@link urlScheme}.
 */
export const URL_SCHEME_PREFIX_RE = /^([a-z][a-z0-9+.-]*):\/\//i;

/** True when `value` begins with a `scheme://` prefix (e.g. `https://`, `skill://`). */
export function hasUrlScheme(value: string): boolean {
	return URL_SCHEME_PREFIX_RE.test(value);
}

/**
 * The RFC 3986 scheme grammar followed only by its `:` separator, with no `//`.
 * This is the looser sibling of {@link URL_SCHEME_PREFIX_RE}: it matches any
 * absolute-URI prefix (`https:`, `file:`, `node:`, `mailto:`, `data:`), not
 * only hierarchical `scheme://` URLs. Use it to tell an absolute URI or module
 * specifier from a bare filesystem path or a bare package name. Non-global, so
 * `.test` stays stateless.
 */
export const URI_SCHEME_PREFIX_RE = /^[a-z][a-z0-9+.-]*:/i;

/** True when `value` begins with a URI scheme prefix (`scheme:`, with or without `//`). */
export function hasUriScheme(value: string): boolean {
	return URI_SCHEME_PREFIX_RE.test(value);
}

/**
 * The lowercased scheme of a leading `scheme://` prefix, or `null` when `value`
 * has none. Lowercasing matches the scheme-lookup keys every caller used before
 * (`match[1].toLowerCase()`), so schemes compare case-insensitively.
 */
export function urlScheme(value: string): string | null {
	const match = URL_SCHEME_PREFIX_RE.exec(value);
	return match ? match[1].toLowerCase() : null;
}

/**
 * The same scheme grammar, unanchored: matches a `scheme://` anywhere in
 * `value`, not only at the start. This is a deliberately looser test than
 * {@link hasUrlScheme}, kept as its own owner so the two intents cannot be
 * confused. Used to tell a URL entry from a filesystem path in compaction
 * file-summary passes, where the input is a bare token that either is a URL or
 * is a path.
 */
export const URL_SCHEME_ANYWHERE_RE = /[a-z][a-z0-9+.-]*:\/\//i;

/** True when `value` contains a `scheme://` anywhere in the string. */
export function containsUrlScheme(value: string): boolean {
	return URL_SCHEME_ANYWHERE_RE.test(value);
}
