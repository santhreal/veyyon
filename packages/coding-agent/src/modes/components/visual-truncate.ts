/** Shared utility for truncating text to visual lines (accounting for line wrapping). Used by both tool-execution.ts and bash-execution.ts for consistent behavior. */
import { Text } from "@veyyon/tui";

export interface VisualTruncateResult {
	/** The visual lines to display */
	visualLines: readonly string[];
	/** Number of visual lines that were skipped (hidden) */
	skippedCount: number;
}

const textCache = new Map<number, Text>();

function getCachedText(paddingX: number): Text {
	let text = textCache.get(paddingX);
	if (!text) {
		text = new Text("", paddingX, 0);
		textCache.set(paddingX, text);
	}
	return text;
}

/** Truncate text to a maximum number of visual lines (from the end). This accounts for line wrapping based on terminal width. */
export function truncateToVisualLines(
	text: string,
	maxVisualLines: number,
	width: number,
	paddingX: number = 0,
): VisualTruncateResult {
	if (!text) {
		return { visualLines: [], skippedCount: 0 };
	}

	// Create a temporary Text component to render and get visual lines
	const tempText = getCachedText(paddingX);
	if (tempText.getText() !== text) {
		tempText.setText(text);
	}
	const allVisualLines = tempText.render(width);

	if (allVisualLines.length <= maxVisualLines) {
		return { visualLines: allVisualLines, skippedCount: 0 };
	}

	// Take the last N visual lines
	const truncatedLines = allVisualLines.slice(-maxVisualLines);
	const skippedCount = allVisualLines.length - maxVisualLines;

	return { visualLines: truncatedLines, skippedCount };
}
