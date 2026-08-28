import type { Component } from "../tui";
import { padding, truncateToWidth } from "../utils";

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

		const emptyLine = padding(width);

		for (let i = 0; i < this.#paddingY; i++) {
			result.push(emptyLine);
		}

		const availableWidth = Math.max(0, width - this.#paddingX * 2);

		let singleLineText = this.#text;
		const breakIndex = this.#text.search(/[\r\n]/);
		if (breakIndex !== -1) {
			singleLineText = this.#text.slice(0, breakIndex);
		}

		const displayText = truncateToWidth(singleLineText, availableWidth);

		const leftPadding = padding(this.#paddingX);
		const rightPadding = padding(this.#paddingX);
		const lineWithPadding = leftPadding + displayText + rightPadding;

		result.push(lineWithPadding);

		for (let i = 0; i < this.#paddingY; i++) {
			result.push(emptyLine);
		}

		this.#cachedWidth = width;
		this.#cachedLines = result;
		return result;
	}
}
