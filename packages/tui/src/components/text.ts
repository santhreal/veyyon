import type { Component, RenderStablePrefix } from "../tui";
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
export class Text implements Component, RenderStablePrefix {
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

	// Padded twin of the wrap-prefix cache: margin+background+width padding for
	// the stable wrapped rows. Padding a row is pure in (row, width, bgFn), so
	// stable rows keep their padded form across appends and only the volatile
	// tail rows pay visibleWidth/padding each frame.
	#padPrefixRows: string[] = [];
	#padPrefixWidth?: number;

	// RenderStablePrefix accumulator: leading output rows provably identical to
	// the render array state the engine last observed. Each rebuild lowers it
	// to min(accum, rows this render kept from the previous one); a read
	// re-bases it to the full current length. Lets the engine skip re-ingesting
	// a streaming Text's settled rows every frame.
	#stablePrefixAccum = 0;

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
		this.#padPrefixRows = [];
		this.#padPrefixWidth = undefined;
	}

	invalidate(): void {
		this.#cachedText = undefined;
		this.#cachedWidth = undefined;
		this.#cachedLines = undefined;
		this.#wrapPrefixText = undefined;
		this.#wrapPrefixWidth = undefined;
		this.#wrapPrefixRows = undefined;
		this.#wrapPrefixCarry = "";
		this.#padPrefixRows = [];
		this.#padPrefixWidth = undefined;
		this.#stablePrefixAccum = 0;
	}

	getRenderStablePrefixRows(observed: readonly string[]): number {
		// Only the exact cached render array is covered by this accounting.
		if (observed !== this.#cachedLines) {
			this.#stablePrefixAccum = 0;
			return 0;
		}
		const report = this.#stablePrefixAccum;
		// Reading consumes: the reader now observes the current array in full.
		this.#stablePrefixAccum = observed.length;
		return report;
	}

	/**
	 * Wrap `normalized` to `contentWidth`, reusing the wrapped rows of every
	 * logical line that was already complete (ended in "\n") on the previous
	 * render when the new text extends the old. The carried SGR state is
	 * baked into the re-wrapped tail, so styling across the reuse boundary
	 * matches a from-scratch wrap.
	 */
	#wrapIncremental(normalized: string, contentWidth: number): { rows: string[]; stableRows: number } {
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
		} else {
			// Non-append edit or width change: the padded twin is stale too.
			this.#padPrefixRows = [];
			if (boundary > 0) {
				prefixRows = wrapTextWithAnsi(stable.slice(0, -1), contentWidth);
				carry = sgrCarryAfter("", stable);
			} else {
				prefixRows = [];
				carry = "";
			}
		}

		this.#wrapPrefixText = stable;
		this.#wrapPrefixWidth = contentWidth;
		this.#wrapPrefixRows = prefixRows;
		this.#wrapPrefixCarry = carry;

		const tailRows = wrapTextWithAnsi(carry + normalized.slice(boundary), contentWidth);
		return {
			rows: prefixRows.length > 0 ? prefixRows.concat(tailRows) : tailRows,
			stableRows: prefixRows.length,
		};
	}

	render(width: number): readonly string[] {
		// Check cache
		if (this.#cachedLines && this.#cachedText === this.#text && this.#cachedWidth === width) {
			return this.#cachedLines;
		}

		// Don't render anything if there's no actual text. /\S/ stops at the
		// first non-whitespace char; trim() would copy the whole (possibly
		// still-streaming) string just to test emptiness.
		if (!this.#text || !/\S/.test(this.#text)) {
			const result: string[] = [];
			this.#cachedText = this.#text;
			this.#cachedWidth = width;
			this.#cachedLines = result;
			this.#stablePrefixAccum = 0;
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
		const { rows: wrappedLines, stableRows } = this.#wrapIncremental(normalizedText, contentWidth);

		// Add margins and background to each line. Stable rows reuse their
		// padded form from the previous render; only tail rows are re-padded.
		if (this.#padPrefixWidth !== width) {
			this.#padPrefixRows = [];
			this.#padPrefixWidth = width;
		}
		const leftMargin = padding(paddingX);
		const rightMargin = padding(paddingX);
		const padLine = (line: string): string => {
			const lineWithMargins = leftMargin + line + rightMargin;
			// Apply background if specified (this also pads to full width)
			if (this.#customBgFn) {
				return applyBackgroundToLine(lineWithMargins, width, this.#customBgFn);
			}
			// No background - just pad to width with spaces
			const visibleLen = visibleWidth(lineWithMargins);
			return lineWithMargins + padding(Math.max(0, width - visibleLen));
		};
		const paddedPrefix = this.#padPrefixRows;
		// Rows this render provably keeps from the previous returned array: the
		// top padding plus the padded rows already materialized before this
		// render (only valid when some survived — a reset means nothing carries).
		const keptRows = paddedPrefix.length > 0 ? this.#paddingY + paddedPrefix.length : 0;
		this.#stablePrefixAccum = Math.min(this.#stablePrefixAccum, keptRows);
		for (let i = paddedPrefix.length; i < stableRows; i++) {
			paddedPrefix.push(padLine(wrappedLines[i] ?? ""));
		}
		const contentLines: string[] = paddedPrefix.slice(0, stableRows);
		for (let i = stableRows; i < wrappedLines.length; i++) {
			contentLines.push(padLine(wrappedLines[i] ?? ""));
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
