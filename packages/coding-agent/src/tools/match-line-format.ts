/** Format a single line of match output for grep/ast-grep style results. Matched lines are prefixed with `*`; context lines are prefixed with a single */
export function formatMatchLine(
	lineNumber: number,
	line: string,
	isMatch: boolean,
	options: { useHashLines: boolean },
): string {
	const marker = isMatch ? "*" : " ";
	if (options.useHashLines) {
		return `${marker}${lineNumber}:${line}`;
	}
	return `${marker}${lineNumber}|${line}`;
}
