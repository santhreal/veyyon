export interface BorderCharacters {
	topLeft: string;
	topRight: string;
	bottomLeft: string;
	bottomRight: string;
	horizontal: string;
	vertical: string;
}

/**
 * Format a horizontal border rule with corner glyphs.
 */
export function formatBorderRule(
	left: string,
	horizontal: string,
	innerCols: number,
	right: string,
	colorFn?: (str: string) => string,
): string {
	const rule = horizontal.repeat(Math.max(0, innerCols));
	const text = `${left}${rule}${right}`;
	return colorFn ? colorFn(text) : text;
}

/**
 * Format interior lines framed by vertical border characters.
 */
export function frameBorderLines(
	lines: readonly string[],
	vertical: string,
	colorFn?: (str: string) => string,
): string[] {
	const side = colorFn ? colorFn(vertical) : vertical;
	return lines.map(line => `${side}${line}${side}`);
}
