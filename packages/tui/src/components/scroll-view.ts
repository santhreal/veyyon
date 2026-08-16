import { matchesKey } from "../keys";
import { MOTION } from "../motion";
import { SettleValue, type SettleValueOptions } from "../motion-settle";
import type { Component } from "../tui";
import { clamp, Ellipsis, replaceTabs, truncateToWidth, visibleWidth } from "../utils";

const DEFAULT_TRACK = "│";
const DEFAULT_THUMB = "█";
/**
 * A change this small lands instead of travelling. One row of travel is a
 * quarter of a second spent not showing the row the key asked for, and a
 * streaming viewport that follows its own tail grows a row at a time.
 */
const MIN_TRAVEL_ROWS = 2;

type ScrollbarMode = "auto" | "always" | "never";

export interface ScrollViewTheme {
	track?: (text: string) => string;
	thumb?: (text: string) => string;
}

export interface ScrollViewOptions {
	height: number;
	/** Defaults to "auto". "auto" reserves a scrollbar column only when content overflows. */
	scrollbar?: ScrollbarMode | boolean;
	/** Logical row count for pre-windowed line slices. Defaults to lines.length. */
	totalRows?: number;
	theme?: ScrollViewTheme;
	trackChar?: string;
	thumbChar?: string;
	/**
	 * Indicator appended when a row overflows `contentWidth`. Defaults to
	 * {@link Ellipsis.Unicode}. Pass {@link Ellipsis.Omit} when callers wrap
	 * lines to width themselves and only trailing padding can overflow (e.g.
	 * the plan-review overlay), so no stray `…` lands on every padded row.
	 */
	ellipsis?: Ellipsis;
	/**
	 * Rows moved per keystroke when {@link ScrollView.handleScrollKey} sees a
	 * Shift+Arrow (the "scroll faster" affordance). Defaults to 5.
	 */
	fastScrollLines?: number;
}

function normalizeScrollbarMode(scrollbar: ScrollViewOptions["scrollbar"]): ScrollbarMode {
	if (scrollbar === true) return "auto";
	if (scrollbar === false) return "never";
	return scrollbar ?? "auto";
}

function firstCellGlyph(value: string, fallback: string): string {
	const glyph = Array.from(value)[0] ?? fallback;
	return visibleWidth(glyph) === 1 ? glyph : fallback;
}

/**
 * Fixed-height viewport over pre-rendered lines, with optional right-edge scrollbar.
 *
 * ScrollView owns only the row offset. Callers remain responsible for producing
 * already-wrapped logical lines appropriate for the current render width.
 */
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
	#motion: SettleValue | undefined;

	constructor(lines: readonly string[], options: ScrollViewOptions) {
		this.#lines = [...lines];
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

	/**
	 * Walk the viewport to its new offset instead of cutting to it.
	 *
	 * Off by default, and opt-in for the same reason {@link
	 * SelectList.setHoverMotion} is: the frames between two keystrokes have no
	 * input to hang off, so the host has to lend the viewport its repaint. A
	 * host that rebuilds its ScrollView every render must NOT call this — the
	 * travel it starts would be thrown away with the instance, and the clock
	 * would keep ticking for a viewport nobody can see. Call
	 * {@link disposeScrollMotion} when the host goes away.
	 *
	 * `enabled: false` is the cut, which is what `display.transitions: off`
	 * gets.
	 *
	 * What travels is a scroll: a wheel notch, an arrow, a page, a jump to a
	 * known offset. What lands is everything that is not someone moving through
	 * the content — the ends ({@link scrollToTop}, {@link scrollToBottom}, which
	 * is also how a viewport follows its own tail), a re-layout that moves the
	 * offset because the content changed underneath it, a change of less than
	 * {@link MIN_TRAVEL_ROWS}, and a jump further than two screens, which is too
	 * far to read on the way past.
	 */
	setScrollMotion(options: Omit<SettleValueOptions, "curve" | "epsilon">): void {
		this.#motion?.dispose();
		this.#motion = new SettleValue({ ...options, curve: MOTION.move, epsilon: MIN_TRAVEL_ROWS });
		this.#motion.set(this.#scrollOffset);
	}

	/** Drop the travel and everything it registered with the clock. */
	disposeScrollMotion(): void {
		this.#motion?.dispose();
		this.#motion = undefined;
	}

	setLines(lines: readonly string[]): void {
		// The defensive copy is deliberate and must stay: transcript components
		// mutate their previously returned render arrays in place (streaming
		// row caches), so a same-reference fast path here serves STALE rows —
		// the agent-hub transcript tail froze exactly that way (2026-07-24).
		// The copy is O(content) but ~20us at 10k rows; render() stays
		// O(viewport) regardless.
		this.#lines = [...lines];
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

	/**
	 * Where the viewport is headed, which is where the keyboard thinks it is. A
	 * travelling viewport sits between two offsets for a few frames, and every
	 * caller that asks this — a follow-bottom check, a ToC cursor, a focus
	 * handoff at the ends — wants the offset the key produced rather than the
	 * frame it happens to be on.
	 */
	getScrollOffset(): number {
		return this.#scrollOffset;
	}

	getMaxScrollOffset(): number {
		const rowCount = this.#totalRows ?? this.#lines.length;
		return Math.max(0, rowCount - this.#height);
	}

	setScrollOffset(offset: number): void {
		this.#aim(Number.isFinite(offset) ? Math.trunc(offset) : 0, "travel");
	}

	scroll(delta: number): void {
		this.setScrollOffset(this.#scrollOffset + (Number.isFinite(delta) ? Math.trunc(delta) : 0));
	}

	page(delta: number): void {
		const step = Math.max(1, this.#height - 1);
		this.scroll(step * (Number.isFinite(delta) ? Math.trunc(delta) : 0));
	}

	scrollToTop(): void {
		this.#aim(0, "land");
	}

	scrollToBottom(): void {
		this.#aim(this.getMaxScrollOffset(), "land");
	}

	/**
	 * Apply a standard navigation key to the viewport. Shift+Arrow scrolls by
	 * {@link ScrollViewOptions.fastScrollLines} (the "scroll faster" affordance);
	 * plain Arrow by one line; PageUp/PageDown by a page; Home/End to the ends.
	 * Returns true when the key was consumed, so callers can fall through to
	 * their own (e.g. vim-style) bindings. Generic on purpose: every ScrollView
	 * consumer gets the same scroll keys, including Shift-to-go-faster.
	 */
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

	invalidate(): void {
		// No cached layout to invalidate.
	}

	/**
	 * Columns a caller may draw into at `width`, once the scrollbar has taken its
	 * gutter.
	 *
	 * Exposed because the reserve is this component's rule, and a caller that
	 * guessed it is wrong exactly when the guess matters. {@link render}
	 * truncates every line it is given to this width, and a truncation that lands
	 * inside a background fill drops the escape that CLOSES the fill, so the
	 * colour runs on through the gutter and the bar. A caller that pads or fills a
	 * row to full width asks for this width instead.
	 */
	contentWidth(width: number): number {
		const safeWidth = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
		// Two columns when the bar shows: one breathing-space gap + the bar
		// itself — right-aligned content must never kiss the scrollbar glyph.
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
		const offset = this.#paintedOffset();
		for (let row = 0; row < this.#height; row++) {
			const sourceIndex = this.#totalRows === undefined ? offset + row : row;
			const source = this.#lines[sourceIndex] ?? "";
			const truncated = truncateToWidth(replaceTabs(source), contentWidth, this.#ellipsis);
			if (!showScrollbar) {
				lines.push(truncated);
				continue;
			}
			const content = `${truncated}${" ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)))}`;
			const barGlyph = thumb && row >= thumb.start && row < thumb.end ? this.#thumbChar : this.#trackChar;
			const styledBar =
				thumb && row >= thumb.start && row < thumb.end ? this.#theme.thumb(barGlyph) : this.#theme.track(barGlyph);
			lines.push(`${content} ${styledBar}`);
		}
		return lines;
	}

	/**
	 * Re-clamp the target after the content or the height changed underneath it,
	 * and land there: a viewport whose bottom moved has not been scrolled. This
	 * runs on every render, so it must do nothing at all when the clamp does not
	 * move — landing unconditionally here would cut short every travel on the
	 * frame after it started.
	 */
	#clampScrollOffset(): void {
		const clamped = clamp(this.#scrollOffset, 0, this.getMaxScrollOffset());
		if (clamped === this.#scrollOffset) return;
		this.#aim(clamped, "land");
	}

	/**
	 * Point the viewport at `offset`. `land` is every move that is not someone
	 * travelling through the content; {@link setScrollMotion} says which is
	 * which.
	 */
	#aim(offset: number, mode: "land" | "travel"): void {
		this.#scrollOffset = clamp(Number.isFinite(offset) ? Math.trunc(offset) : 0, 0, this.getMaxScrollOffset());
		const motion = this.#motion;
		if (!motion) return;
		const from = motion.value ?? this.#scrollOffset;
		motion.set(this.#scrollOffset);
		// Three ways a travel is not worth having: it is not a scroll; the rows
		// are the caller's own window, so nothing on screen would move anyway; or
		// it is further than two screens, which is past the far edge of a travel
		// worth watching — the rows in between are a blur and the reader is
		// waiting on the one they asked for.
		const tooFar = Math.abs(this.#scrollOffset - from) > this.#height * 2;
		if (mode === "land" || this.#totalRows !== undefined || tooFar) motion.finish();
	}

	/**
	 * Where the viewport is this frame, which is between two offsets while a
	 * scroll travels. Both readings of it — the rows {@link render} slices and
	 * the thumb {@link #thumbRange} puts on the track — come from here, so the
	 * bar can never disagree with the content beside it.
	 *
	 * A pre-windowed viewport ({@link ScrollViewOptions.totalRows}) reads the
	 * target instead: the caller sliced the rows itself against the offset it
	 * asked for, and a thumb travelling behind rows that already moved would
	 * point at a row that is not on screen.
	 */
	#travelled(): number {
		if (this.#totalRows !== undefined) return this.#scrollOffset;
		const value = this.#motion?.value;
		if (value === undefined) return this.#scrollOffset;
		return clamp(value, 0, this.getMaxScrollOffset());
	}

	/** {@link #travelled}, on a row boundary, because a row is what paints. */
	#paintedOffset(): number {
		return Math.round(this.#travelled());
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
		const start = maxOffset === 0 ? 0 : Math.round((this.#travelled() / maxOffset) * travel);
		return { start, end: start + thumbSize };
	}
}
