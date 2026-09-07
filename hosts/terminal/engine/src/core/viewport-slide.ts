/**
 * The sideways viewport slide: the transition a room switch plays between the
 * window one conversation was showing and the window the next one composes.
 *
 * It reuses the resize drag's throwaway frame and its settle paint. Each step
 * paints one width-fitted window on the borrowed alternate screen, never
 * touching the commit ledger, and the last step queues the same authoritative
 * full paint a drag settles with, which also lands every render requested
 * while the slide ran. The `TUI` supplies the host below and holds its own
 * render loop back while {@link ViewportSlide.active} is set.
 */
import { sliceByColumn, visibleWidth } from "@veyyon/utils/width";
import type { RenderScheduler, RenderTimer } from "./render-scheduler";

/**
 * The window the terminal shows, captured by {@link ViewportSlide.capture} for
 * a {@link ViewportSlide.slide}. Opaque: rows are width-fitted and the
 * geometry is what the slide checks the terminal still has.
 */
export interface ViewportSnapshot {
	readonly rows: readonly string[];
	readonly width: number;
	readonly height: number;
}

export interface ViewportSlideOptions {
	/** Frames the slide takes, the last of which is the authoritative full paint. */
	steps?: number;
	/** Milliseconds between frames. */
	stepMs?: number;
}

export type ViewportSlideDirection = "left" | "right";

/** What the slide needs from the engine, each member a closure over its private state. */
export interface ViewportSlideHost {
	readonly scheduler: RenderScheduler;
	/** Terminal geometry now. */
	size(): { width: number; height: number };
	/**
	 * Whether a slide can start: the engine has painted, the normal screen is
	 * what the terminal shows (no overlay, no resident alt transcript, no
	 * resize drag), and the host is not a multiplexer that repaints in place,
	 * which is the one place the borrowed alternate screen is not available.
	 */
	ready(): boolean;
	/** The engine has stopped: a frame due now is dropped, with no settle. */
	stopped(): boolean;
	/** An overlay opened mid-slide: the next frame is the settle, so the screen under it is authoritative. */
	overlayVisible(): boolean;
	/** The last committed window and the geometry it was committed at. */
	committed(): ViewportSnapshot;
	/** The incoming window, composed the way a resize frame is: visible tail, width-fitted. */
	compose(width: number, height: number): readonly string[];
	/** Paint one throwaway frame on the borrowed alternate screen. */
	paint(window: readonly string[], width: number, height: number): void;
	/** Queue the authoritative full paint that ends a slide, as a settled resize drag does. */
	settle(): void;
}

// Seven slid frames 16ms apart, then the authoritative replay, so the whole
// move takes about the length of a keystroke repeat and never outlasts a
// second key.
const SLIDE_STEPS = 8;
const SLIDE_STEP_MS = 16;

/** Pad `line` with spaces to exactly `width` cells; a wider line is cut. */
export function padToWidth(line: string, width: number): string {
	const w = visibleWidth(line);
	if (w === width) return line;
	if (w < width) return line + " ".repeat(width - w);
	return sliceByColumn(line, 0, width, true);
}

/**
 * The outgoing and incoming windows joined side by side, one row per line.
 * Every row of both is padded to the full width and closed with a style reset
 * before the two are joined, so the seam sits at exactly `width` columns and
 * the outgoing row's colours never bleed into the incoming one.
 */
export function joinSlideRows(
	from: readonly string[],
	to: readonly string[],
	width: number,
	height: number,
	direction: ViewportSlideDirection,
): string[] {
	const joined: string[] = new Array(height);
	for (let r = 0; r < height; r++) {
		const out = padToWidth(from[r] ?? "", width);
		const inc = padToWidth(to[r] ?? "", width);
		joined[r] = direction === "left" ? `${out}\x1b[0m${inc}` : `${inc}\x1b[0m${out}`;
	}
	return joined;
}

/**
 * The window `offset` columns into the joined rows. `"left"` moves the screen
 * contents left, so the new window enters from the right; `"right"` is the
 * mirror. A wide glyph straddling the cut is dropped (strict).
 */
export function slideFrame(
	joined: readonly string[],
	offset: number,
	width: number,
	direction: ViewportSlideDirection,
): string[] {
	const start = direction === "left" ? offset : width - offset;
	const window: string[] = new Array(joined.length);
	for (let r = 0; r < joined.length; r++) {
		window[r] = sliceByColumn(joined[r]!, start, width, true);
	}
	return window;
}

export class ViewportSlide {
	readonly #host: ViewportSlideHost;
	#timer: RenderTimer | undefined;
	#frames = 0;

	constructor(host: ViewportSlideHost) {
		this.#host = host;
	}

	/** Whether a slide is in flight. */
	get active(): boolean {
		return this.#timer !== undefined;
	}

	/** Throwaway frames painted so far, across every slide. */
	get frames(): number {
		return this.#frames;
	}

	#canStart(): boolean {
		return this.#timer === undefined && this.#host.ready();
	}

	/** Drop a slide in flight without its settle paint; the engine is stopping. */
	cancel(): void {
		this.#timer?.cancel();
		this.#timer = undefined;
	}

	/**
	 * Snapshot the window the terminal is showing, to slide away from. Take it
	 * BEFORE changing the children: the snapshot is the last committed window,
	 * and a render scheduled while the caller is between the two states would
	 * otherwise commit a half-changed frame over it. `undefined` when a slide
	 * cannot run, in which case the caller's ordinary repaint is the whole
	 * transition.
	 */
	capture(): ViewportSnapshot | undefined {
		if (!this.#canStart()) return undefined;
		return this.#host.committed();
	}

	/**
	 * Slide from `from` to the window the children compose now. Returns false,
	 * painting nothing, when a slide cannot run or the terminal has changed size
	 * since the snapshot; the caller's own repaint then stands.
	 */
	slide(from: ViewportSnapshot, direction: ViewportSlideDirection, options?: ViewportSlideOptions): boolean {
		if (!this.#canStart()) return false;
		const { width, height } = this.#host.size();
		if (width <= 0 || height <= 0 || width !== from.width || height !== from.height) return false;
		const steps = Math.max(1, Math.floor(options?.steps ?? SLIDE_STEPS));
		const stepMs = Math.max(0, options?.stepMs ?? SLIDE_STEP_MS);
		const joined = joinSlideRows(from.rows, this.#host.compose(width, height), width, height, direction);

		let step = 0;
		const paint = (): void => {
			this.#timer = undefined;
			if (this.#host.stopped()) return;
			step += 1;
			const now = this.#host.size();
			if (step >= steps || now.width !== width || now.height !== height || this.#host.overlayVisible()) {
				// The last step is the authoritative paint itself, not one more
				// throwaway frame: it leaves the borrowed alternate screen and
				// replays history exactly as a settled resize drag does.
				this.#host.settle();
				return;
			}
			this.#host.paint(slideFrame(joined, Math.round((step * width) / steps), width, direction), width, height);
			this.#frames += 1;
			this.#timer = this.#host.scheduler.scheduleRender(paint, stepMs);
		};
		this.#timer = this.#host.scheduler.scheduleRender(paint, 0);
		return true;
	}
}
