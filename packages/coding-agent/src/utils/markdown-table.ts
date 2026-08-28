/** Escape a value so it occupies exactly one cell of a GitHub-flavored Markdown table. Two characters break a table: a `|` ends the current cell, and a */
export function escapeMarkdownTableCell(value: string): string {
	return value.replace(/[\r\n\t]+/g, " ").replace(/\|/g, "\\|");
}

/** Render a grid of plain-text cells as a GitHub-flavored Markdown table: the first row is the header, the rest the body, with a `---` delimiter row between */
export function renderMarkdownTable(rows: string[][]): string {
	if (rows.length === 0) return "";
	// Fold the widest-row search with a loop, not `Math.max(...rows.map(...))`. Spreading an array into a call throws RangeError once it exceeds the
	let maxCols = 0;
	for (const row of rows) {
		if (row.length > maxCols) maxCols = row.length;
	}
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
