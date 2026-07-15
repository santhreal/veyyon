import { padding, truncateToWidth, visibleWidth } from "@veyyon/pi-tui";
import { gradientLogo, VEYYON_LOGO } from "../../components/welcome";
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
 * Setup splash: quiet black field, silver wordmark reveal left→right,
 * hairline progress. No starfield, no doubled glyphs, no rainbow.
 */
export function renderSetupSplash(width: number, height: number, elapsedMs: number): string[] {
	const w = Math.max(1, width);
	const h = Math.max(1, height);
	const progress = Math.max(0, Math.min(1, elapsedMs / SETUP_SPLASH_MS));
	const eased = 1 - (1 - progress) ** 3;
	const edge = Math.max(0, 1 - eased) ** 1.2;

	const art = gradientLogo(VEYYON_LOGO, 0, { pos: eased, strength: edge });
	const railMax = Math.max(1, Math.min(w - 10, visibleWidth(VEYYON_LOGO[0] ?? "") + 4));
	const filled = Math.max(1, Math.floor(railMax * eased));
	const rail =
		theme.fg("accent", "━".repeat(filled)) + theme.fg("borderMuted", "─".repeat(Math.max(0, railMax - filled)));

	const content = [
		...art,
		"",
		theme.bold(theme.fg("accent", "Veyyon")),
		theme.fg("dim", "coding agent"),
		"",
		rail,
	];
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
