import { TERMINAL } from "@veyyon/tui";
import { APP_NAME, clampLow } from "@veyyon/utils";
import { centerLine, padLineToWidth } from "@veyyon/utils/padding";
import { theme } from "../../../../theme/theme";
import { sunMark } from "../../components/chrome/sun";
import { silverEscape } from "../../components/dialogs/welcome";

export const SETUP_SPLASH_MS = 2400;
export const SETUP_TICK_MS = 33;

// Esc, not ctrl+c: Esc leaves setup from the splash and from every step, so the
// hint names one key for one meaning. Advertising ctrl+c told a user that
// getting out of onboarding meant killing the program.
const START_HINT = "enter start setup  ·  esc skip setup";

/**
 * Setup splash: the resting brand signature rendered immediately on first paint.
 * The full-bloomed sun mark rests over the silver letterspaced wordmark, so
 * the initial frame is the complete finished frame with zero entrance delay.
 */
export function renderSetupSplash(width: number, height: number, _elapsedMs = 0): string[] {
	const w = Math.max(1, width);
	const h = Math.max(1, height);

	// Sun sized to the field but capped so it stays a tasteful disc, not a wall.
	// Rows ≈ cols / 2.1 keeps the disc round under terminal cell aspect (sunMark
	// applies the same correction internally).
	const sunCols = clampLow(Math.floor(w * 0.45), 9, 32);
	const sunRows = clampLow(Math.round(sunCols / 2.1), 5, 16);
	const sun = sunMark(sunCols, sunRows, {
		trueColor: TERMINAL.trueColor,
		time: 0.6,
	});

	const content: string[] = [
		...sun,
		"",
		`${silverEscape(0.55)}${theme.bold(APP_NAME.split("").join(" "))}\x1b[39m`,
		theme.fg("dim", "coding agent"),
	];

	const start = Math.max(0, Math.floor((h - content.length) / 2));
	const lines: string[] = [];
	for (let y = 0; y < h; y++) {
		const item = content[y - start];
		lines.push(padLineToWidth(item !== undefined ? centerLine(item, w) : "", w));
	}
	if (h > 2) lines[h - 2] = padLineToWidth(centerLine(theme.fg("dim", START_HINT), w), w);
	return lines;
}
