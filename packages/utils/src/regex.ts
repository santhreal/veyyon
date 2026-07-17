/**
 * Escape a literal string for safe insertion into a RegExp source.
 */
export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * RFC 3986 `scheme://` prefix test (capture group 1 = the scheme, unlowercased).
 * ONE PLACE: shared by path/URL routers that must agree on what counts as a
 * URL-like path vs a filesystem path. No `g` flag, safe for repeated .test().
 */
export const URL_SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;

/**
 * Same scheme grammar, unanchored: true when a `scheme://` URL appears
 * anywhere in the string (e.g. a path with an embedded `conflict://` selector).
 * Derived from {@link URL_SCHEME_RE} so the grammar cannot fork.
 */
export const URL_SCHEME_ANYWHERE_RE = new RegExp(URL_SCHEME_RE.source.slice(1), "i");

/**
 * Anchored http(s)-URL detector. Case-insensitive because RFC 3986 schemes
 * are; strict about `://` (both slashes). ONE PLACE for the "is this an http
 * URL" predicate shared by fetch, MCP config, LSP path routing, and web-search
 * providers. Lenient variants (optional second slash) and multi-scheme
 * alternations are distinct grammars, not copies.
 */
export const HTTP_URL_RE = /^https?:\/\//i;

/** Canonical 8-4-4-4-12 UUID, case-insensitive. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bare ISO calendar date (`YYYY-MM-DD`), no time component. */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A line that is exactly one opening XML-ish tag (not self-closing, not
 * closing). Lowercase tag names only — conservative by design so prose like
 * `<Enter>` is ignored. Capture group 1 = the tag name. ONE PLACE: shared by
 * prompt-format parsing and compaction tree-shaking, which must agree on what
 * counts as a structural tag line.
 */
export const OPENING_XML_TAG_RE = /^<([a-z_-]+)(?:\s+[^>]*)?>$/;

/** Closing twin of {@link OPENING_XML_TAG_RE}: a line that is exactly `</tag>`. */
export const CLOSING_XML_TAG_RE = /^<\/([a-z_-]+)>$/;

/**
 * True when the string carries at least one Unicode letter or digit — the
 * shared "has substantive content" predicate (drops punctuation/whitespace-only
 * strings). ONE PLACE for hindsight retain/recall and TTS speakability.
 */
export const HAS_LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;

/**
 * Runs of non-alphanumeric characters (Unicode-aware). The shared word-split /
 * normalize separator: `.split(NON_ALNUM_RUNS_RE)` or
 * `.replace(NON_ALNUM_RUNS_RE, " ")`. Callers use only split/replace, which
 * reset `lastIndex`, so sharing the `g`-flagged object is safe.
 */
export const NON_ALNUM_RUNS_RE = /[^\p{L}\p{N}]+/gu;

const BASE64_STRICT_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Strict standard-alphabet base64: non-empty, length a multiple of four,
 * optional `=` padding only. URL-safe base64 and embedded whitespace are
 * rejected. ONE PLACE for byte-field validation (Google thought signatures,
 * Anthropic image sources).
 */
export function isStrictBase64(value: string): boolean {
	return value.length > 0 && value.length % 4 === 0 && BASE64_STRICT_RE.test(value);
}
