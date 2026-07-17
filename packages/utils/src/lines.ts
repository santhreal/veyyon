/**
 * Split text on `\n` into trimmed, non-empty lines.
 *
 * Per-line trimming also strips `\r`, so CRLF input needs no special casing.
 * The canonical way to consume line-oriented CLI output (git, jj, ...).
 */
export function trimmedNonEmptyLines(text: string): string[] {
	return text
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
}

/** Count lines that contain any non-whitespace character. */
export function countNonEmptyLines(text: string): number {
	let count = 0;
	for (const line of text.split("\n")) {
		if (line.trim().length > 0) count++;
	}
	return count;
}

/** Collapse all whitespace runs to single spaces and trim; null/undefined become "". */
export function collapseWhitespace(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}
