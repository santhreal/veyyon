import type { Component } from "../tui";
import { applyBackgroundToLine, getPaddingX, padding, visibleWidth } from "../utils";

type Cache = {
	width: number;
	bgSample: string | undefined;
	borderSample: string | undefined;
	childLines: (readonly string[])[];
	result: string[];
};

/** Box-drawing glyphs plus an optional colorizer for an outline drawn around a {@link Box}. */
export interface BoxBorder {
	chars: {
		topLeft: string;
		topRight: string;
		bottomLeft: string;
		bottomRight: string;
		horizontal: string;
		vertical: string;
	};
	color?: (text: string) => string;
}

/**
 * Box component - a container that applies padding and background to all children
 */
export class Box implements Component {
	children: Component[] = [];
	#paddingX: number;
	#paddingY: number;
	#bgFn?: (text: string) => string;
	#border?: BoxBorder;

	#ignoreTight = false;

	setIgnoreTight(ignore: boolean): this {
		this.#ignoreTight = ignore;
		this.#invalidateCache();
		return this;
	}

	// Cache for rendered output
	#cached?: Cache;

	constructor(paddingX = 1, paddingY = 1, bgFn?: (text: string) => string, border?: BoxBorder) {
		this.#paddingX = paddingX;
		this.#paddingY = paddingY;
		this.#bgFn = bgFn;
		this.#border = border;
	}

	addChild(component: Component): void {
		this.children.push(component);
		if (this.#ignoreTight) {
			component.setIgnoreTight?.(true);
		}
		this.#invalidateCache();
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.#invalidateCache();
		}
	}

	clear(): void {
		this.children = [];
		this.#invalidateCache();
	}

	setPaddingX(paddingX: number): void {
		if (this.#paddingX === paddingX) return;
		this.#paddingX = paddingX;
		this.#invalidateCache();
	}

	setPaddingY(paddingY: number): void {
		if (this.#paddingY === paddingY) return;
		this.#paddingY = paddingY;
		this.#invalidateCache();
	}

	setBgFn(bgFn?: (text: string) => string): void {
		this.#bgFn = bgFn;
		// Don't invalidate here - we'll detect bgFn changes by sampling output
	}

	setBorder(border?: BoxBorder): void {
		this.#border = border;
		this.#invalidateCache();
	}

	#hugContent = false;

	/**
	 * When set, the box shrinks to its widest child line (plus padding and
	 * border) instead of padding every row out to the width it was given. The
	 * given width stays the wrap limit — children still render at the full
	 * content width, hugging only trims the emitted rows. A bordered card
	 * around three short lines reads as a card; the same frame stretched to
	 * the terminal edge reads as a wall (the "box always spans full width
	 * regardless of content" report, 2026-07-22). No effect when a child
	 * already fills the width (its rows are pre-padded).
	 */
	setHugContent(hug: boolean): this {
		if (this.#hugContent !== hug) {
			this.#hugContent = hug;
			this.#invalidateCache();
		}
		return this;
	}

	#invalidateCache(): void {
		this.#cached = undefined;
	}

	invalidate(): void {
		this.#invalidateCache();
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): readonly string[] {
		const children = this.children;
		const count = children.length;
		const paddingX = this.#ignoreTight ? this.#paddingX : getPaddingX(this.#paddingX);
		// A border eats one column on each side; skip it unless the interior can still
		// hold the horizontal padding plus at least one content column, so a bordered
		// Box never overflows the width it was given.
		const border = this.#border && width - 2 >= paddingX * 2 + 1 ? this.#border : undefined;
		const innerWidth = border ? width - 2 : width;
		const contentWidth = Math.max(1, innerWidth - paddingX * 2);
		// bgFn / border output can change without the function reference changing
		// (theme mutation); sample both so a silent palette swap still misses the cache.
		const bgSample = this.#bgFn ? this.#bgFn("test") : undefined;
		const borderSample = border
			? `${border.color ? border.color("|") : "|"}${border.chars.topLeft}${border.chars.vertical}`
			: undefined;

		// Render every child every frame (renders may carry side effects); the
		// memo only skips re-deriving the padded/background rows. Per the
		// Component render contract, identical child array references prove the
		// content is unchanged.
		const cached = this.#cached;
		let unchanged =
			cached !== undefined &&
			cached.width === width &&
			cached.bgSample === bgSample &&
			cached.borderSample === borderSample &&
			cached.childLines.length === count;
		const childLines: (readonly string[])[] = new Array(count);
		let contentRows = 0;
		for (let i = 0; i < count; i++) {
			const lines = children[i]!.render(contentWidth);
			childLines[i] = lines;
			contentRows += lines.length;
			if (unchanged && cached!.childLines[i] !== lines) unchanged = false;
		}
		if (unchanged) return cached!.result;

		const result: string[] = [];
		if (contentRows > 0) {
			// Hugging: emit rows at the widest child line, not the full width.
			// The children already wrapped at contentWidth, so this only trims
			// the padding (and the border rule) down to the real ink.
			let emitWidth = innerWidth;
			if (this.#hugContent) {
				// Children like Markdown right-pad their rows with raw spaces;
				// measure past that padding or every card measures full-width.
				// Only bare trailing spaces are trimmed — bg-painted padding ends
				// in escape bytes and is preserved as part of the visual design.
				let maxChildWidth = 0;
				for (const lines of childLines) {
					for (const line of lines) {
						const w = visibleWidth(line.replace(/ +$/, ""));
						if (w > maxChildWidth) maxChildWidth = w;
					}
				}
				emitWidth = Math.min(innerWidth, Math.max(1, maxChildWidth + paddingX * 2));
			}
			const leftPad = padding(paddingX);
			const interior: string[] = [];
			// Top padding
			for (let i = 0; i < this.#paddingY; i++) {
				interior.push(this.#applyBg("", emitWidth));
			}
			// Content
			for (const lines of childLines) {
				for (const line of lines) {
					interior.push(
						this.#applyBg(this.#hugContent ? leftPad + line.replace(/ +$/, "") : leftPad + line, emitWidth),
					);
				}
			}
			// Bottom padding
			for (let i = 0; i < this.#paddingY; i++) {
				interior.push(this.#applyBg("", emitWidth));
			}

			if (border) {
				const paint = border.color ?? (s => s);
				const rule = border.chars.horizontal.repeat(Math.max(0, emitWidth));
				const side = paint(border.chars.vertical);
				result.push(paint(border.chars.topLeft + rule + border.chars.topRight));
				for (const row of interior) {
					result.push(side + row + side);
				}
				result.push(paint(border.chars.bottomLeft + rule + border.chars.bottomRight));
			} else {
				for (const row of interior) {
					result.push(row);
				}
			}
		}

		this.#cached = { width, bgSample, borderSample, childLines, result };
		return result;
	}

	#applyBg(line: string, width: number): string {
		const visLen = visibleWidth(line);
		const padNeeded = Math.max(0, width - visLen);
		const padded = line + padding(padNeeded);

		if (this.#bgFn) {
			return applyBackgroundToLine(padded, width, this.#bgFn);
		}
		return padded;
	}
}
