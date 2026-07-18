/**
 * Escape a literal string for safe insertion into a RegExp source.
 * Single repo-wide owner — do not hand-roll local escapeRegExp/escapeRegex
 * copies (locked by packages/utils/test/escape-regexp-lock.test.ts).
 */
export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
