import { centerLine, padLineToWidth, TERMINAL } from "@veyyon/tui";
import { APP_NAME, clamp01 } from "@veyyon/utils";
import { renderSunsetField } from "../../components/sun";
import { silverEscape } from "../../components/welcome";
import { theme } from "../../theme/theme";

export const SETUP_OUTRO_MS = 1600;

/**
 * Outro: the day closes. A small ember sunset under the silver wordmark, a
 * quiet handoff line — then the sunrise of the main TUI.
 */
export function renderSetupOutro(width: number, height: number, elapsedMs: number): string[] {
	const progress = clamp01(elapsedMs / SETUP_OUTRO_MS);
	const eased = 1 - (1 - progress) ** 2;
	const sunset = renderSunsetField({ cols: 18, rows: 5, time: 0.3 + eased * 0.4, trueColor: TERMINAL.trueColor });
	const wordmark = `${silverEscape(0.55)}${theme.bold(APP_NAME.split("").join(" "))}\x1b[39m`;
	const subtitle = theme.fg("dim", "setup saved — the sun is up");
	const content = [...sunset, "", wordmark, subtitle];
	const start = Math.max(0, Math.floor((height - content.length) / 2));
	const lines: string[] = Array.from({ length: height }, () => "");
	for (let i = 0; i < content.length && start + i < lines.length; i++) {
		lines[start + i] = centerLine(content[i] ?? "", width);
	}
	return lines.map(line => padLineToWidth(line, width));
}
