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

/**
 * Render a grid of plain-text cells as a GitHub-flavored Markdown table: the
 * first row is the header, the rest the body, with a `---` delimiter row between
 * them. Every cell is escaped through {@link escapeMarkdownTableCell}.
 *
 * Rows are squared off to the width of the widest row, and the header is padded
 * with empty cells too. This matters for ragged input: a body row with MORE
 * cells than the header would otherwise run past the delimiter row, and GFM
 * renderers silently drop every surplus cell, losing that data without a trace.
 * Padding the header to the full width keeps every column addressable.
 *
 * This is the single owner of table *layout* (the header/delimiter/body shape
 * and column normalization) for the spreadsheet and slide converters, which
 * built the identical structure inline and had drifted: one normalized ragged
 * rows and the other did not. Returns `""` for an empty grid or one whose rows
 * hold no cells.
 */
export function renderMarkdownTable(rows: string[][]): string {
	if (rows.length === 0) return "";
	const maxCols = Math.max(...rows.map(row => row.length));
	if (maxCols === 0) return "";
	const pad = (row: string[]): string[] => {
		const filled = row.slice();
		while (filled.length < maxCols) filled.push("");
		return filled;
	};
	const [header, ...body] = rows;
	const lines: string[] = [`| ${pad(header).map(escapeMarkdownTableCell).join(" | ")} |`];
	lines.push(
		`| ${pad(header)
			.map(() => "---")
			.join(" | ")} |`,
	);
	for (const row of body) {
		lines.push(`| ${pad(row).map(escapeMarkdownTableCell).join(" | ")} |`);
	}
	return lines.join("\n");
}
