import { padding, TERMINAL, truncateToWidth, visibleWidth } from "@veyyon/pi-tui";
import { APP_NAME } from "@veyyon/pi-utils";
import { sunMark } from "../../components/sun";
import { theme } from "../../theme/theme";

export const SETUP_SPLASH_MS = 2400;
export const SETUP_TICK_MS = 33;

const SKIP_HINT = "press enter to skip";

function clampLine(line: string, width: number): string {
	const truncated = truncateToWidth(line, width);
	return truncated + padding(Math.max(0, width - visibleWidth(truncated)));
}

function centerLine(line: string, width: number): string {
	const lineWidth = visibleWidth(line);
	if (lineWidth >= width) return truncateToWidth(line, width);
	const left = Math.floor((width - lineWidth) / 2);
	return padding(left) + line + padding(width - left - lineWidth);
}

/**
 * Setup splash: the launch signature. On a quiet black field the living ember
 * sun blooms open from a point (bloom 0→1, eased) while its ember churns, then
 * the lowercase `veyyon` wordmark reveals beneath it as the disc settles. This
 * is the same `sunMark` recipe the welcome card rests on — the sun IS the logo.
 * No starfield, no doubled glyphs, no rainbow.
 */
export function renderSetupSplash(width: number, height: number, elapsedMs: number): string[] {
	const w = Math.max(1, width);
	const h = Math.max(1, height);
	const progress = Math.max(0, Math.min(1, elapsedMs / SETUP_SPLASH_MS));
	const eased = 1 - (1 - progress) ** 3;

	// Sun sized to the field but capped so it stays a tasteful disc, not a wall.
	// Rows ≈ cols / 2.1 keeps the disc round under terminal cell aspect (sunMark
	// applies the same correction internally).
	const sunCols = Math.max(9, Math.min(32, Math.floor(w * 0.45)));
	const sunRows = Math.max(5, Math.min(16, Math.round(sunCols / 2.1)));
	// Ember churns forward as it blooms, so the disc reads as alive, not a static
	// stamp fading in.
	const sun = sunMark(sunCols, sunRows, { trueColor: TERMINAL.trueColor, bloom: eased, time: 0.25 + eased * 0.7 });

	// Wordmark reveals only once the disc is most of the way open, so the eye lands
	// on the sun first and the name second — the micro-interaction the harness lives on.
	const nameReveal = Math.max(0, Math.min(1, (eased - 0.45) / 0.55));
	const content: string[] = [...sun];
	if (nameReveal > 0) {
		content.push("");
		content.push(theme.bold(theme.fg("accent", APP_NAME)));
		if (nameReveal > 0.5) content.push(theme.fg("dim", "coding agent"));
	}

	const start = Math.max(0, Math.floor((h - content.length) / 2));
	const lines: string[] = [];
	for (let y = 0; y < h; y++) {
		const item = content[y - start];
		lines.push(clampLine(item !== undefined ? centerLine(item, w) : "", w));
	}
	if (h > 2) lines[h - 2] = clampLine(centerLine(theme.fg("dim", SKIP_HINT), w), w);
	return lines;
}

/** Sparse silver dust for outro only — recessive, not a starfield carnival. */
export function renderStarfield(width: number, height: number, frame: number): string[] {
	const lines: string[] = [];
	for (let y = 0; y < height; y++) {
		let line = "";
		for (let x = 0; x < width; x++) {
			const hash = (x * 73856093) ^ (y * 19349663) ^ (frame * 83492791);
			const bucket = Math.abs(hash) % 220;
			if (bucket === 0) line += theme.fg("dim", "·");
			else line += " ";
		}
		lines.push(line);
	}
	return lines;
}

export function screenGradientT(x: number, y: number, width: number, height: number, phase: number): number {
	const span = Math.max(1, width + height - 1);
	const base = (x + (height - 1 - y)) / span;
	return (((base + phase) % 1) + 1) % 1;
}
