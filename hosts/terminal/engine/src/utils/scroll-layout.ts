import { matchesKey } from "@veyyon/utils/keys";
import { clamp, clampLow } from "@veyyon/utils/math";

/**
 * Calculate scrollbar thumb range [start, end) within viewport height.
 */
export function computeThumbRange(
	height: number,
	totalRows: number,
	scrollOffset: number,
): { start: number; end: number } {
	if (height <= 0) return { start: 0, end: 0 };
	if (totalRows <= height) return { start: 0, end: height };
	const thumbSize = clamp(Math.floor((height * height) / totalRows), 1, height);
	const travel = height - thumbSize;
	const maxOffset = Math.max(0, totalRows - height);
	const start = maxOffset === 0 ? 0 : clampLow(Math.round((scrollOffset / maxOffset) * travel), 0, travel);
	return { start, end: start + thumbSize };
}

/**
 * Handle standard scroll navigation keys (Shift+Arrows, Arrows, PageUp/Down, Home/End).
 */
export function handleStandardScrollKey(
	data: string,
	scroll: (delta: number) => void,
	page: (delta: number) => void,
	scrollToTop: () => void,
	scrollToBottom: () => void,
	fastScrollLines = 5,
): boolean {
	if (matchesKey(data, "shift+up")) {
		scroll(-fastScrollLines);
		return true;
	}
	if (matchesKey(data, "shift+down")) {
		scroll(fastScrollLines);
		return true;
	}
	if (matchesKey(data, "up")) {
		scroll(-1);
		return true;
	}
	if (matchesKey(data, "down")) {
		scroll(1);
		return true;
	}
	if (matchesKey(data, "pageUp")) {
		page(-1);
		return true;
	}
	if (matchesKey(data, "pageDown")) {
		page(1);
		return true;
	}
	if (matchesKey(data, "home")) {
		scrollToTop();
		return true;
	}
	if (matchesKey(data, "end")) {
		scrollToBottom();
		return true;
	}
	return false;
}
