import { type MotionClock, subCellBar } from "@veyyon/tui";
import { clampLow, formatBytes } from "@veyyon/utils";
import type { TinyTitleProgressEvent } from "../../tiny/title-protocol";
import { theme } from "../theme/theme";

export const DEFAULT_BAR_WIDTH = 24;

export function progressBar(ratio: number | undefined, width: number): string {
	const barWidth = clampLow(width, 8, DEFAULT_BAR_WIDTH);
	const ramp = theme.getBarRamp();
	if (ratio === undefined) return theme.fg("muted", ramp.track.repeat(barWidth));
	const bar = subCellBar(ratio, barWidth, { ramp });
	const trackAt = bar.indexOf(ramp.track);
	return trackAt < 0
		? theme.fg("accent", bar)
		: `${theme.fg("accent", bar.slice(0, trackAt))}${theme.fg("muted", bar.slice(trackAt))}`;
}

export function currentFile(event: TinyTitleProgressEvent | undefined): string | undefined {
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

export function statusLabel(event: TinyTitleProgressEvent | undefined): string {
	if (!event) return "Preparing";
	if (event.status === "error") return "Failed";
	if (event.status === "ready") return "Ready";
	if (event.status === "done") return "Downloaded";
	if (event.status === "download") return "Downloading";
	if (event.status === "progress" || event.status === "progress_total") return "Downloading";
	return "Preparing";
}

export function byteLabel(event: TinyTitleProgressEvent | undefined): string | undefined {
	if (!event?.loaded || !event.total) return undefined;
	return `${formatBytes(event.loaded)} / ${formatBytes(event.total)}`;
}

export interface TinyTitleDownloadProgressOptions {
	requestRender?: () => void;
	enabled?: boolean;
	clock?: MotionClock;
}
