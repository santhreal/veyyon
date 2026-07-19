/**
 * Escape a literal string for safe insertion into a RegExp source.
 * Single repo-wide owner — do not hand-roll local escapeRegExp/escapeRegex
 * copies (locked by packages/utils/test/escape-regexp-lock.test.ts).
 */
export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A UUID in the canonical 8-4-4-4-12 lowercase-hex form, any version.
 * Case-insensitive. Anchored, so it matches only when the whole string is a
 * UUID. Non-global, so `.test()` is safe to call repeatedly on the shared
 * instance. Single repo-wide owner — prefer `isUuid` over hand-rolling this
 * literal (version-specific patterns like UUID v7 stay separate).
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` is a canonical UUID string (any version). */
export function isUuid(value: string): boolean {
	return UUID_RE.test(value);
}
