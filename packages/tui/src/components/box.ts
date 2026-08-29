import type { Component } from "../tui";
import { applyBackgroundToLine, getPaddingX, padding, visibleWidth } from "../utils";

import type { BoxBorder, Cache } from "./box-helpers";

export * from "./box-helpers";

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
	}

	setBorder(border?: BoxBorder): void {
		this.#border = border;
		this.#invalidateCache();
	}

	#hugContent = false;

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
		for (let ci = 0; ci < this.children.length; ci++) {
			this.children[ci]!.invalidate?.();
		}
	}

	render(width: number): readonly string[] {
		const children = this.children;
		const count = children.length;
		const paddingX = this.#ignoreTight ? this.#paddingX : getPaddingX(this.#paddingX);
		const border = this.#border && width - 2 >= paddingX * 2 + 1 ? this.#border : undefined;
		const innerWidth = border ? width - 2 : width;
		const contentWidth = Math.max(1, innerWidth - paddingX * 2);
		const bgSample = this.#bgFn ? this.#bgFn("test") : undefined;
		const borderSample = border
			? `${border.color ? border.color("|") : "|"}${border.chars.topLeft}${border.chars.vertical}`
			: undefined;

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
			let emitWidth = innerWidth;
			if (this.#hugContent) {
				let maxChildWidth = 0;
				for (let ci = 0; ci < childLines.length; ci++) {
					const lines = childLines[ci]!;
					for (let li = 0; li < lines.length; li++) {
						const w = visibleWidth(lines[li]!.replace(/ +$/, ""));
						if (w > maxChildWidth) maxChildWidth = w;
					}
				}
				emitWidth = Math.min(innerWidth, Math.max(1, maxChildWidth + paddingX * 2));
			}
			const leftPad = padding(paddingX);
			const interior: string[] = [];
			for (let i = 0; i < this.#paddingY; i++) {
				interior.push(this.#applyBg("", emitWidth));
			}
			for (let ci = 0; ci < childLines.length; ci++) {
				const lines = childLines[ci]!;
				for (let li = 0; li < lines.length; li++) {
					const line = lines[li]!;
					interior.push(
						this.#applyBg(this.#hugContent ? leftPad + line.replace(/ +$/, "") : leftPad + line, emitWidth),
					);
				}
			}
			for (let i = 0; i < this.#paddingY; i++) {
				interior.push(this.#applyBg("", emitWidth));
			}

			if (border) {
				const paint = border.color ?? (s => s);
				const rule = border.chars.horizontal.repeat(Math.max(0, emitWidth));
				const side = paint(border.chars.vertical);
				result.push(paint(border.chars.topLeft + rule + border.chars.topRight));
				for (let ri = 0; ri < interior.length; ri++) {
					result.push(side + interior[ri]! + side);
				}
				result.push(paint(border.chars.bottomLeft + rule + border.chars.bottomRight));
			} else {
				for (let ri = 0; ri < interior.length; ri++) {
					result.push(interior[ri]!);
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
