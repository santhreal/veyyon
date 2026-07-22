/**
 * Escape a value so it occupies exactly one cell of a GitHub-flavored Markdown
 * table. Two characters break a table: a `|` ends the current cell, and a
 * newline ends the whole row. This escapes `|` to `\|` and collapses any run of
 * `\r`, `\n`, or `\t` to a single space. The tab is only cosmetic (it never
 * breaks a row), but it is folded here so every producer treats whitespace the
 * same way.
 *
 * This is the single owner of Markdown-table cell escaping. Import it; do not
 * hand-roll another copy. The PDF converter's `escapePipes` is deliberately not
 * routed through this: it keeps a different contract (newlines become `<br>` to
 * preserve multi-line PDF cells, plus full-width ASCII normalization).
 */
export function escapeMarkdownTableCell(value: string): string {
	return value.replace(/[\r\n\t]+/g, " ").replace(/\|/g, "\\|");
}
