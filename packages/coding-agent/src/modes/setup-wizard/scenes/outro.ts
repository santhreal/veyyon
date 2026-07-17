import { centerLine, padding, TERMINAL, truncateToWidth, visibleWidth } from "@veyyon/pi-tui";
import { renderSunsetField } from "../../components/sun";
import { theme } from "../../theme/theme";

export const SETUP_OUTRO_MS = 1600;


function clampLine(line: string, width: number): string {
	const truncated = truncateToWidth(line, width);
	return truncated + padding(Math.max(0, width - visibleWidth(truncated)));
}

/**
 * The closing beat of the ceremony: the sun that rose in the splash now sets.
 * A dithered blood-orange sky melts toward a hot horizon line, sparks rising —
 * then the handoff lines settle beneath it. Same sunset as the website's page
 * finale, in the terminal's own cells.
 */
export function renderSetupOutro(width: number, height: number, elapsedMs: number): string[] {
	const progress = Math.max(0, Math.min(1, elapsedMs / SETUP_OUTRO_MS));
	const eased = 1 - (1 - progress) ** 2;

	const cols = Math.max(24, Math.min(64, width - 8));
	const rows = Math.max(7, Math.min(13, Math.floor(height * 0.42)));
	const sunset = renderSunsetField({
		cols,
		rows,
		time: 0.4 + (elapsedMs / 1000) * 0.6,
		trueColor: TERMINAL.trueColor,
	});

	const title = theme.fg("muted", "Setup saved");
	const subtitle = theme.fg("dim", "Opening Veyyon…");
	const railMax = Math.max(1, Math.min(width - 10, 24));
	const filled = Math.max(1, Math.floor(railMax * eased));
	const rail =
		theme.fg("accent", "━".repeat(filled)) + theme.fg("borderMuted", "─".repeat(Math.max(0, railMax - filled)));

	const content = [...sunset, "", title, subtitle, "", rail];
	const start = Math.max(0, Math.floor((height - content.length) / 2));
	const lines: string[] = Array.from({ length: height }, () => "");
	for (let i = 0; i < content.length && start + i < lines.length; i++) {
		lines[start + i] = centerLine(content[i] ?? "", width);
	}
	return lines.map(line => clampLine(line, width));
}
