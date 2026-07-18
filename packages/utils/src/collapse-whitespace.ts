/**
 * Collapse every run of whitespace (spaces, tabs, newlines, CR) to a single
 * space and trim the ends. `null`/`undefined` yield an empty string.
 *
 * The one repo-wide owner of the `(x ?? "").replace(/\s+/g, " ").trim()`
 * idiom that flattens multi-line or messily-spaced text onto a single line —
 * HTML-scraped result text, transcript previews, status-line headers, commit
 * summaries. Import this instead of re-inlining the regex.
 *
 * Dependency-free by design: it lives in its own module (not `sanitize-text`,
 * which references `Bun.stripANSI`) so browser-bundle-safe consumers such as
 * `@veyyon/tool-render` can import it from the `@veyyon/utils/collapse-whitespace`
 * subpath without dragging a Bun reference into the bundle.
 */
export function collapseWhitespace(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}
