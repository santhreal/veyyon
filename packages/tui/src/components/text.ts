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

/**
 * Text component - displays multi-line text with word wrapping
 */
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

	// Cache for rendered output
	#cachedText?: string;
	#cachedWidth?: number;
	#cachedLines?: string[];

	// Append-aware wrap cache: wrapped rows for every logical line up to the
	// last "\n" boundary of the previous render, plus the SGR carry open at
	// that boundary. Streaming appends (the token-by-token assistant path)
	// re-wrap only the unfinished last line instead of the whole accumulated
	// text, turning an O(text²) stream into O(text).
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

	/**
	 * Wrap `normalized` to `contentWidth`, reusing the wrapped rows of every
	 * logical line that was already complete (ended in "\n") on the previous
	 * render when the new text extends the old. The carried SGR state is
	 * baked into the re-wrapped tail, so styling across the reuse boundary
	 * matches a from-scratch wrap.
	 */
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
				// New complete logical lines appeared since the last render:
				// wrap just those (with the carry replayed) and commit them.
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
		// Check cache
		if (this.#cachedLines && this.#cachedText === this.#text && this.#cachedWidth === width) {
			return this.#cachedLines;
		}

		// Don't render anything if there's no actual text
		if (!this.#text || this.#text.trim() === "") {
			const result: string[] = [];
			this.#cachedText = this.#text;
			this.#cachedWidth = width;
			this.#cachedLines = result;
			return result;
		}

		// Replace tabs with 3 spaces; normalize newlines up front so the
		// incremental wrap's prefix offsets index the exact text that gets
		// wrapped.
		const normalizedText = normalizeWrapInput(replaceTabs(this.#text));

		// Calculate content width (subtract left/right margins)
		const paddingX = this.#ignoreTight ? this.#paddingX : getPaddingX(this.#paddingX);
		const contentWidth = Math.max(1, width - paddingX * 2);
		// Wrap text (this preserves ANSI codes but does NOT pad)
		const wrappedLines = this.#wrapIncremental(normalizedText, contentWidth);

		// Add margins and background to each line
		const leftMargin = padding(paddingX);
		const rightMargin = padding(paddingX);
		const contentLines: string[] = [];

		for (const line of wrappedLines) {
			// Add margins
			const lineWithMargins = leftMargin + line + rightMargin;

			// Apply background if specified (this also pads to full width)
			if (this.#customBgFn) {
				contentLines.push(applyBackgroundToLine(lineWithMargins, width, this.#customBgFn));
			} else {
				// No background - just pad to width with spaces
				const visibleLen = visibleWidth(lineWithMargins);
				const paddingNeeded = Math.max(0, width - visibleLen);
				contentLines.push(lineWithMargins + padding(paddingNeeded));
			}
		}

		// Add top/bottom padding (empty lines)
		const emptyLine = padding(width);
		const emptyLines: string[] = [];
		for (let i = 0; i < this.#paddingY; i++) {
			const line = this.#customBgFn ? applyBackgroundToLine(emptyLine, width, this.#customBgFn) : emptyLine;
			emptyLines.push(line);
		}

		const result = [...emptyLines, ...contentLines, ...emptyLines];

		// Update cache
		this.#cachedText = this.#text;
		this.#cachedWidth = width;
		this.#cachedLines = result;

		return result.length > 0 ? result : [""];
	}
}
