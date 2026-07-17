import { padding, truncateToWidth, visibleWidth } from "@veyyon/pi-tui";
import { gradientLogo, VEYYON_LOGO } from "../../components/welcome";
import { theme } from "../../theme/theme";

export const SETUP_OUTRO_MS = 1100;

function centerLine(line: string, width: number): string {
	const lineWidth = visibleWidth(line);
	if (lineWidth >= width) return truncateToWidth(line, width);
	const left = Math.floor((width - lineWidth) / 2);
	return padding(left) + line + padding(width - left - lineWidth);
}

function clampLine(line: string, width: number): string {
	const truncated = truncateToWidth(line, width);
	return truncated + padding(Math.max(0, width - visibleWidth(truncated)));
}

/** Quiet handoff: settled silver wordmark on empty field — no starfield. */
export function renderSetupOutro(width: number, height: number, elapsedMs: number): string[] {
	void SETUP_OUTRO_MS;
	const progress = Math.max(0, Math.min(1, elapsedMs / SETUP_OUTRO_MS));
	const eased = 1 - (1 - progress) ** 2;
	const logo = gradientLogo(VEYYON_LOGO, 0, { pos: 1, strength: Math.max(0, 1 - eased) * 0.35 });
	const title = theme.fg("muted", "Setup saved");
	const subtitle = theme.fg("dim", "Opening Veyyon…");
	const railMax = Math.max(1, Math.min(width - 10, visibleWidth(VEYYON_LOGO[0] ?? "") + 4));
	const filled = Math.max(1, Math.floor(railMax * eased));
	const rail =
		theme.fg("accent", "━".repeat(filled)) + theme.fg("borderMuted", "─".repeat(Math.max(0, railMax - filled)));
	const content = [...logo, "", title, subtitle, "", rail];
	const start = Math.max(0, Math.floor((height - content.length) / 2));
	const lines: string[] = Array.from({ length: height }, () => "");
	for (let i = 0; i < content.length && start + i < lines.length; i++) {
		lines[start + i] = centerLine(content[i] ?? "", width);
	}
	return lines.map(line => clampLine(line, width));
}
