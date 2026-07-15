import type { Component } from "../tui";
import { padding, truncateToWidth } from "../utils";

/**
 * Text component that truncates to fit viewport width
 */
export class TruncatedText implements Component {
	#text: string;
	#paddingX: number;
	#paddingY: number;
	#cachedWidth = -1;
	#cachedLines: string[] | undefined;

	constructor(text: string, paddingX: number = 0, paddingY: number = 0) {
		this.#text = text;
		this.#paddingX = paddingX;
		this.#paddingY = paddingY;
	}

	invalidate(): void {
		this.#cachedWidth = -1;
		this.#cachedLines = undefined;
	}

	render(width: number): readonly string[] {
		if (this.#cachedLines && this.#cachedWidth === width) {
			return this.#cachedLines;
		}
		const result: string[] = [];

		// Empty line padded to width
		const emptyLine = padding(width);

		// Add vertical padding above
		for (let i = 0; i < this.#paddingY; i++) {
			result.push(emptyLine);
		}

		// Calculate available width after horizontal padding
		const availableWidth = Math.max(1, width - this.#paddingX * 2);

		// Take only the first line. Cut at the first CR or LF: cutting on `\n`
		// alone leaves a stray `\r` from a CRLF source in the output, which moves
		// the terminal cursor to column 0 and corrupts the rendered row; a bare
		// `\r` (no `\n`) would slip through entirely. Cutting before either keeps
		// the line a single clean row.
		let singleLineText = this.#text;
		const breakIndex = this.#text.search(/[\r\n]/);
		if (breakIndex !== -1) {
			singleLineText = this.#text.slice(0, breakIndex);
		}

		// Truncate text if needed (accounting for ANSI codes)
		const displayText = truncateToWidth(singleLineText, availableWidth);

		// Add horizontal padding
		const leftPadding = padding(this.#paddingX);
		const rightPadding = padding(this.#paddingX);
		const lineWithPadding = leftPadding + displayText + rightPadding;

		// Don't pad to full width - avoids trailing spaces when copying
		result.push(lineWithPadding);

		// Add vertical padding below
		for (let i = 0; i < this.#paddingY; i++) {
			result.push(emptyLine);
		}

		this.#cachedWidth = width;
		this.#cachedLines = result;
		return result;
	}
}
