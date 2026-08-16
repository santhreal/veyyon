import type { Component } from "@veyyon/tui";
import { clamp01, clampLow, formatBytes } from "@veyyon/utils";
import { getTinyTitleModelSpec, type TinyTitleLocalModelKey } from "../../tiny/models";
import type { TinyTitleProgressEvent } from "../../tiny/title-protocol";
import { theme } from "../theme/theme";
import { COMPOSER_INSET_COLS } from "./composer-chrome";

const DEFAULT_BAR_WIDTH = 24;

function progressBar(progress: number | undefined, width: number): string {
	const barWidth = clampLow(width, 8, DEFAULT_BAR_WIDTH);
	if (progress === undefined) return theme.fg("muted", "░".repeat(barWidth));
	const ratio = clamp01(progress / 100);
	const filled = Math.round(ratio * barWidth);
	return `${theme.fg("accent", "█".repeat(filled))}${theme.fg("muted", "░".repeat(barWidth - filled))}`;
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

export class TinyTitleDownloadProgressComponent implements Component {
	#modelKey: TinyTitleLocalModelKey;
	#event: TinyTitleProgressEvent | undefined;

	constructor(modelKey: TinyTitleLocalModelKey) {
		this.#modelKey = modelKey;
	}

	update(event: TinyTitleProgressEvent): void {
		this.#event = event;
	}

	isComplete(): boolean {
		return this.#event?.status === "ready" || this.#event?.status === "error";
	}

	invalidate(): void {
		// No cached state.
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
		const details = [
			progressBar(this.#event?.progress, Math.max(8, width - COMPOSER_INSET_COLS - 36)),
			...[pct, bytes, file].filter((part): part is string => Boolean(part)).map(part => theme.fg("dim", part)),
		].join(" ");

		return [`${inset}${title}`, `${inset}${details}`];
	}
}
