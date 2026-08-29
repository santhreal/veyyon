import { matchesKey } from "../keys";
import type { Component } from "../tui";
import { clamp, Ellipsis, replaceTabs, truncateToWidth } from "../utils";
import type { ScrollbarMode, ScrollViewOptions, ScrollViewTheme } from "./scroll-view-helpers";
import { DEFAULT_THUMB, DEFAULT_TRACK, firstCellGlyph, normalizeScrollbarMode } from "./scroll-view-helpers";

export class ScrollView implements Component {
	#lines: readonly string[];
	#height: number;
	#scrollOffset = 0;
	#totalRows: number | undefined;
	#scrollbar: ScrollbarMode;
	#theme: Required<ScrollViewTheme>;
	#trackChar: string;
	#thumbChar: string;
	#ellipsis: Ellipsis;
	#fastScrollLines: number;

	constructor(lines: readonly string[], options: ScrollViewOptions) {
		this.#lines = lines.slice();
		this.#height = Number.isFinite(options.height) ? Math.max(0, Math.trunc(options.height)) : 0;
		this.#totalRows = options.totalRows === undefined ? undefined : Math.max(0, Math.trunc(options.totalRows));
		this.#scrollbar = normalizeScrollbarMode(options.scrollbar);
		this.#theme = {
			track: options.theme?.track ?? (text => text),
			thumb: options.theme?.thumb ?? (text => text),
		};
		this.#trackChar = firstCellGlyph(options.trackChar ?? DEFAULT_TRACK, DEFAULT_TRACK);
		this.#thumbChar = firstCellGlyph(options.thumbChar ?? DEFAULT_THUMB, DEFAULT_THUMB);
		this.#ellipsis = options.ellipsis ?? Ellipsis.Unicode;
		this.#fastScrollLines = Math.max(1, Math.trunc(options.fastScrollLines ?? 5));
		this.#clampScrollOffset();
	}

	setLines(lines: readonly string[]): void {
		this.#lines = lines.slice();
		this.#clampScrollOffset();
	}

	setTotalRows(totalRows: number | undefined): void {
		this.#totalRows = totalRows === undefined ? undefined : Math.max(0, Math.trunc(totalRows));
		this.#clampScrollOffset();
	}

	setHeight(height: number): void {
		this.#height = Number.isFinite(height) ? Math.max(0, Math.trunc(height)) : 0;
		this.#clampScrollOffset();
	}

	setScrollbar(scrollbar: ScrollViewOptions["scrollbar"]): void {
		this.#scrollbar = normalizeScrollbarMode(scrollbar);
	}

	getScrollOffset(): number {
		return this.#scrollOffset;
	}

	getMaxScrollOffset(): number {
		const rowCount = this.#totalRows ?? this.#lines.length;
		return Math.max(0, rowCount - this.#height);
	}

	setScrollOffset(offset: number): void {
		this.#scrollOffset = Number.isFinite(offset) ? Math.trunc(offset) : 0;
		this.#clampScrollOffset();
	}

	scroll(delta: number): void {
		this.setScrollOffset(this.#scrollOffset + (Number.isFinite(delta) ? Math.trunc(delta) : 0));
	}

	page(delta: number): void {
		const step = Math.max(1, this.#height - 1);
		this.scroll(step * (Number.isFinite(delta) ? Math.trunc(delta) : 0));
	}

	scrollToTop(): void {
		this.#scrollOffset = 0;
	}

	scrollToBottom(): void {
		this.#scrollOffset = this.getMaxScrollOffset();
	}

	handleScrollKey(data: string): boolean {
		if (matchesKey(data, "shift+up")) {
			this.scroll(-this.#fastScrollLines);
			return true;
		}
		if (matchesKey(data, "shift+down")) {
			this.scroll(this.#fastScrollLines);
			return true;
		}
		if (matchesKey(data, "up")) {
			this.scroll(-1);
			return true;
		}
		if (matchesKey(data, "down")) {
			this.scroll(1);
			return true;
		}
		if (matchesKey(data, "pageUp")) {
			this.page(-1);
			return true;
		}
		if (matchesKey(data, "pageDown")) {
			this.page(1);
			return true;
		}
		if (matchesKey(data, "home")) {
			this.scrollToTop();
			return true;
		}
		if (matchesKey(data, "end")) {
			this.scrollToBottom();
			return true;
		}
		return false;
	}

	invalidate(): void {}

	contentWidth(width: number): number {
		const safeWidth = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
		return Math.max(0, safeWidth - (safeWidth > 0 && this.#shouldRenderScrollbar() ? 2 : 0));
	}

	render(width: number): readonly string[] {
		this.#clampScrollOffset();
		const safeWidth = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
		if (this.#height === 0) return [];
		const showScrollbar = safeWidth > 0 && this.#shouldRenderScrollbar();
		const contentWidth = this.contentWidth(safeWidth);
		const thumb = showScrollbar ? this.#thumbRange() : undefined;
		const lines: string[] = [];
		for (let row = 0; row < this.#height; row++) {
			const sourceIndex = this.#totalRows === undefined ? this.#scrollOffset + row : row;
			const source = this.#lines[sourceIndex] ?? "";
			const truncated = truncateToWidth(replaceTabs(source), contentWidth, this.#ellipsis, showScrollbar);
			if (!showScrollbar) {
				lines.push(truncated);
				continue;
			}
			const barGlyph = thumb && row >= thumb.start && row < thumb.end ? this.#thumbChar : this.#trackChar;
			const styledBar =
				thumb && row >= thumb.start && row < thumb.end ? this.#theme.thumb(barGlyph) : this.#theme.track(barGlyph);
			lines.push(`${truncated} ${styledBar}`);
		}
		return lines;
	}

	#clampScrollOffset(): void {
		this.#scrollOffset = clamp(this.#scrollOffset, 0, this.getMaxScrollOffset());
	}

	#shouldRenderScrollbar(): boolean {
		if (this.#height <= 0) return false;
		if (this.#scrollbar === "never") return false;
		if (this.#scrollbar === "always") return true;
		return (this.#totalRows ?? this.#lines.length) > this.#height;
	}

	#thumbRange(): { start: number; end: number } {
		if (this.#height <= 0) return { start: 0, end: 0 };
		const rowCount = this.#totalRows ?? this.#lines.length;
		if (rowCount <= this.#height) return { start: 0, end: this.#height };
		const thumbSize = clamp(Math.floor((this.#height * this.#height) / rowCount), 1, this.#height);
		const travel = this.#height - thumbSize;
		const maxOffset = this.getMaxScrollOffset();
		const start = maxOffset === 0 ? 0 : Math.round((this.#scrollOffset / maxOffset) * travel);
		return { start, end: start + thumbSize };
	}
}
