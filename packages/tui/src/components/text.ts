import type { Component } from "../tui";
import {
	applyBackgroundToLine,
	getPaddingX,
	normalizeWrapInput,
	padding,
	replaceTabs,
	sgrCarryAfter,
	visibleWidth,
	wrapTextWithAnsi,
} from "../utils";

export class Text implements Component {
	#text: string;
	#paddingX: number; // Left/right padding
	#paddingY: number; // Top/bottom padding
	#customBgFn?: (text: string) => string;

	#ignoreTight = false;

	setIgnoreTight(ignore: boolean): this {
		this.#ignoreTight = ignore;
		this.invalidate();
		return this;
	}

	#cachedText?: string;
	#cachedWidth?: number;
	#cachedLines?: string[];

	#wrapPrefixText?: string;
	#wrapPrefixWidth?: number;
	#wrapPrefixRows?: string[];
	#wrapPrefixCarry = "";

	constructor(text: string = "", paddingX: number = 1, paddingY: number = 1, customBgFn?: (text: string) => string) {
		this.#text = text;
		this.#paddingX = paddingX;
		this.#paddingY = paddingY;
		this.#customBgFn = customBgFn;
	}

	getText(): string {
		return this.#text;
	}

	setText(text: string): boolean {
		if (text === this.#text) {
			return false;
		}
		this.#text = text;
		this.#cachedText = undefined;
		this.#cachedWidth = undefined;
		this.#cachedLines = undefined;
		return true;
	}

	setCustomBgFn(customBgFn?: (text: string) => string): void {
		this.#customBgFn = customBgFn;
		this.#cachedText = undefined;
		this.#cachedWidth = undefined;
		this.#cachedLines = undefined;
	}

	invalidate(): void {
		this.#cachedText = undefined;
		this.#cachedWidth = undefined;
		this.#cachedLines = undefined;
		this.#wrapPrefixText = undefined;
		this.#wrapPrefixWidth = undefined;
		this.#wrapPrefixRows = undefined;
		this.#wrapPrefixCarry = "";
	}

	#wrapIncremental(normalized: string, contentWidth: number): string[] {
		const boundary = normalized.lastIndexOf("\n") + 1; // 0 when single-line
		const stable = normalized.slice(0, boundary);

		let prefixRows: string[];
		let carry: string;
		const cached = this.#wrapPrefixText;
		if (
			cached !== undefined &&
			this.#wrapPrefixWidth === contentWidth &&
			this.#wrapPrefixRows &&
			stable.startsWith(cached)
		) {
			prefixRows = this.#wrapPrefixRows;
			carry = this.#wrapPrefixCarry;
			if (boundary > cached.length) {
				const grown = normalized.slice(cached.length, boundary - 1);
				prefixRows = prefixRows.concat(wrapTextWithAnsi(carry + grown, contentWidth));
				carry = sgrCarryAfter(carry, grown);
			}
		} else if (boundary > 0) {
			prefixRows = wrapTextWithAnsi(stable.slice(0, -1), contentWidth);
			carry = sgrCarryAfter("", stable);
		} else {
			prefixRows = [];
			carry = "";
		}

		this.#wrapPrefixText = stable;
		this.#wrapPrefixWidth = contentWidth;
		this.#wrapPrefixRows = prefixRows;
		this.#wrapPrefixCarry = carry;

		const tailRows = wrapTextWithAnsi(carry + normalized.slice(boundary), contentWidth);
		return prefixRows.length > 0 ? prefixRows.concat(tailRows) : tailRows;
	}

	render(width: number): readonly string[] {
		if (this.#cachedLines && this.#cachedText === this.#text && this.#cachedWidth === width) {
			return this.#cachedLines;
		}

		if (!this.#text || this.#text.trim() === "") {
			const result: string[] = [];
			this.#cachedText = this.#text;
			this.#cachedWidth = width;
			this.#cachedLines = result;
			return result;
		}

		const normalizedText = normalizeWrapInput(replaceTabs(this.#text));

		const paddingX = this.#ignoreTight ? this.#paddingX : getPaddingX(this.#paddingX);
		const contentWidth = Math.max(1, width - paddingX * 2);
		const wrappedLines = this.#wrapIncremental(normalizedText, contentWidth);

		const leftMargin = padding(paddingX);
		const rightMargin = padding(paddingX);
		const contentLines: string[] = [];

		for (let li = 0; li < wrappedLines.length; li++) {
			const line = wrappedLines[li]!;
			const lineWithMargins = leftMargin + line + rightMargin;

			if (this.#customBgFn) {
				contentLines.push(applyBackgroundToLine(lineWithMargins, width, this.#customBgFn));
			} else {
				const visibleLen = visibleWidth(lineWithMargins);
				const paddingNeeded = Math.max(0, width - visibleLen);
				contentLines.push(lineWithMargins + padding(paddingNeeded));
			}
		}

		const emptyLine = padding(width);
		const emptyLines: string[] = [];
		for (let i = 0; i < this.#paddingY; i++) {
			const line = this.#customBgFn ? applyBackgroundToLine(emptyLine, width, this.#customBgFn) : emptyLine;
			emptyLines.push(line);
		}

		const result = emptyLines.concat(contentLines, emptyLines);

		this.#cachedText = this.#text;
		this.#cachedWidth = width;
		this.#cachedLines = result;

		return result.length > 0 ? result : [""];
	}
}
