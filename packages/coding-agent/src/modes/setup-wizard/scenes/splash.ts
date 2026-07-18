import { centerLine, padding, TERMINAL, truncateToWidth, visibleWidth } from "@veyyon/tui";
import { APP_NAME } from "@veyyon/utils";
import { sunMark } from "../../components/sun";
import { silverEscape } from "../../components/welcome";
import { theme } from "../../theme/theme";

export const SETUP_SPLASH_MS = 2400;
export const SETUP_TICK_MS = 33;

const SKIP_HINT = "press enter to skip";

function clampLine(line: string, width: number): string {
	const truncated = truncateToWidth(line, width);
	return truncated + padding(Math.max(0, width - visibleWidth(truncated)));
}

/**
 * Setup splash: a miniature sunrise. The sun blooms open and rises over its
 * own horizon while the ember churns, then the wordmark reveals beneath in
 * quiet silver — the terminal's own font, letterspaced. The same `sunMark`
 * recipe the home screen rests on: the sun IS the logo.
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
	// Rise completes a beat before the bloom, so the disc lifts over the horizon
	// first and the ember catches up — the sunrise, not a fade-in.
	const rise = Math.max(0, Math.min(1, eased * 1.25));
	const sun = sunMark(sunCols, sunRows, {
		trueColor: TERMINAL.trueColor,
		bloom: eased,
		rise,
		time: 0.25 + eased * 0.7,
	});

	// Wordmark reveals only once the disc is most of the way open, so the eye lands
	// on the sun first and the name second — the micro-interaction the harness lives on.
	const nameReveal = Math.max(0, Math.min(1, (eased - 0.45) / 0.55));
	const content: string[] = [...sun];
	if (nameReveal > 0) {
		content.push("");
		content.push(`${silverEscape(0.55)}${theme.bold(APP_NAME.split("").join(" "))}\x1b[39m`);
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
