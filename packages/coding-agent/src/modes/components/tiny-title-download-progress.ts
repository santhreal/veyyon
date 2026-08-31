import { type Component, type MotionClock, SettleValue, subCellBar } from "@veyyon/tui";
import { clamp01, clampLow, formatBytes } from "@veyyon/utils";
import { getTinyTitleModelSpec, type TinyTitleLocalModelKey } from "../../tiny/models";
import type { TinyTitleProgressEvent } from "../../tiny/title-protocol";
import { theme } from "../theme/theme";
import { COMPOSER_INSET_COLS } from "./composer-chrome";

const DEFAULT_BAR_WIDTH = 24;

/**
 * The bar for a ratio already in `[0, 1]`, fill in accent over a muted track.
 *
 * Eight steps per column through the shared owner: a download that reports 1%
 * steps used to move the bar every fourth report and stand still between them.
 * `undefined` is "no number yet", which is the whole track and no fill.
 */
function progressBar(ratio: number | undefined, width: number): string {
	const barWidth = clampLow(width, 8, DEFAULT_BAR_WIDTH);
	const ramp = theme.getBarRamp();
	if (ratio === undefined) return theme.fg("muted", ramp.track.repeat(barWidth));
	const bar = subCellBar(ratio, barWidth, { ramp });
	const trackAt = bar.indexOf(ramp.track);
	return trackAt < 0
		? theme.fg("accent", bar)
		: `${theme.fg("accent", bar.slice(0, trackAt))}${theme.fg("muted", bar.slice(trackAt))}`;
}

function currentFile(event: TinyTitleProgressEvent | undefined): string | undefined {
	if (!event) return undefined;
	if (event.file) return event.file.split("/").at(-1) ?? event.file;
	if (event.files) {
		let largestFile: string | undefined;
		let largestLoaded = -1;
		for (const file in event.files) {
			const state = event.files[file];
			if (state.loaded <= largestLoaded || state.loaded >= state.total) continue;
			largestFile = file;
			largestLoaded = state.loaded;
		}
		return largestFile?.split("/").at(-1) ?? largestFile;
	}
	return undefined;
}

function statusLabel(event: TinyTitleProgressEvent | undefined): string {
	if (!event) return "Preparing";
	if (event.status === "error") return "Failed";
	if (event.status === "ready") return "Ready";
	if (event.status === "done") return "Downloaded";
	if (event.status === "download") return "Downloading";
	if (event.status === "progress" || event.status === "progress_total") return "Downloading";
	return "Preparing";
}

function byteLabel(event: TinyTitleProgressEvent | undefined): string | undefined {
	if (!event?.loaded || !event.total) return undefined;
	return `${formatBytes(event.loaded)} / ${formatBytes(event.total)}`;
}

export interface TinyTitleDownloadProgressOptions {
	/** Repaint hook for the settling frames; without one the bar jumps as before. */
	requestRender?: () => void;
	/**
	 * False lands every reported percentage immediately. The SHOW site decides —
	 * `modalRevealEnabled()` — the same way every other motion in the product is
	 * gated, so a direct construction stays deterministic.
	 */
	enabled?: boolean;
	/** The clock to settle on. Tests pass a hand-ticked one. */
	clock?: MotionClock;
}

export class TinyTitleDownloadProgressComponent implements Component {
	#modelKey: TinyTitleLocalModelKey;
	#event: TinyTitleProgressEvent | undefined;
	/**
	 * Where the bar is right now, as opposed to what the last event said.
	 *
	 * A download reports in ~1% steps, and a cached shard completes in one event
	 * that jumps from nothing to done. Walking the value over `MOTION.settle`
	 * turns both into travel: the reader sees the bar move rather than find it
	 * somewhere else on the next frame. Undefined when the host gave no repaint
	 * hook, because a settling value nobody paints is a timer with no picture.
	 */
	readonly #ratio: SettleValue | undefined;

	constructor(modelKey: TinyTitleLocalModelKey, options: TinyTitleDownloadProgressOptions = {}) {
		this.#modelKey = modelKey;
		const requestRender = options.requestRender;
		if (requestRender) {
			this.#ratio = new SettleValue({ requestRender, enabled: options.enabled, clock: options.clock });
		}
	}

	update(event: TinyTitleProgressEvent): void {
		this.#event = event;
		if (event.progress !== undefined) this.#ratio?.set(clamp01(event.progress / 100));
	}

	isComplete(): boolean {
		return this.#event?.status === "ready" || this.#event?.status === "error";
	}

	invalidate(): void {
		// No cached state.
	}

	/** Stop the settle so no frame is owed after the row leaves the transcript. */
	dispose(): void {
		this.#ratio?.dispose();
	}

	/**
	 * Two rows on the transcript's rail: what is downloading, then how far.
	 *
	 * It used to be a bordered band — a full-width rule above and below, its
	 * rows padded edge to edge from column zero — which made a background
	 * download the loudest thing on screen and put it two columns left of every
	 * other block. A download is a status, so it reads as one.
	 */
	render(width: number): readonly string[] {
		width = Math.max(1, width);
		const inset = " ".repeat(COMPOSER_INSET_COLS);
		const spec = getTinyTitleModelSpec(this.#modelKey);
		const dot = theme.sep.dot.trim();
		const status = statusLabel(this.#event);
		const file = currentFile(this.#event);
		const pct =
			this.#event?.progress === undefined ? "" : `${Math.floor(this.#event.progress).toString().padStart(3, " ")}%`;
		const bytes = byteLabel(this.#event);
		const title = [theme.fg("accent", "Tiny model"), theme.fg("muted", status), theme.fg("dim", spec.label)].join(
			theme.fg("dim", ` ${dot} `),
		);
		// The bar carries its own colors, so the trailing facts are dimmed one by
		// one: wrapping the joined row would end at the bar's own reset and leave
		// the numbers on the default foreground.
		//
		// The bar draws where the value HAS GOT TO and the percent prints what was
		// last reported: the number is the fact, the bar is the travel toward it.
		// With no repaint hook there is nothing settling and the two agree, which
		// is exactly what this rendered before.
		const reported = this.#event?.progress === undefined ? undefined : clamp01(this.#event.progress / 100);
		const details = [
			progressBar(this.#ratio?.value ?? reported, Math.max(8, width - COMPOSER_INSET_COLS - 36)),
			...[pct, bytes, file].filter((part): part is string => Boolean(part)).map(part => theme.fg("dim", part)),
		].join(" ");

		return [`${inset}${title}`, `${inset}${details}`];
	}
}
