import { type Component, centerLine, type OverlayHandle, type OverlayOptions, TERMINAL } from "@veyyon/tui";
import { formatClock } from "@veyyon/utils";
import { theme } from "../theme/theme";
import { renderEmberField } from "./sun";

export interface PauseScreenHost {
	ui: {
		showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
		setFocus(component: Component): void;
		requestRender(): void;
		readonly terminal: { readonly rows: number };
	};
	showStatus(message: string, options?: { dim?: boolean }): void;
	readonly sessionName?: string;
}

export const TICK_MS = 1_000;

export const BAR_ROWS = 7;
export const BAR_WIDTH = 5;
export const BAR_GAP = 4;

export const MIN_FULL_WIDTH = 64;
export const MIN_FULL_HEIGHT = 18;

export const TITLE = "P A U S E D";
export const BODY_LINES = [
	"Main agent, subagents, and advisor hold at their next step.",
	"In-flight calls finish; nothing new starts until you resume.",
] as const;
export const RESUME_HINT = "esc · enter · space · click — resume";
export const COMPACT_RESUME_HINT = "esc · click — resume";

export function renderPauseScreen(width: number, height: number, elapsedMs: number, sessionName?: string): string[] {
	const compact = width < MIN_FULL_WIDTH || height < MIN_FULL_HEIGHT;
	const content: string[] = [];

	if (compact) {
		if (sessionName) {
			content.push(centerLine(theme.bold(sessionName), width));
			content.push("");
		}
		content.push(centerLine(theme.bold(theme.fg("accent", `▌▌ ${TITLE}`)), width));
		content.push("");
		content.push(centerLine(theme.fg("dim", `paused for ${formatClock(elapsedMs)}`), width));
		content.push(centerLine(theme.fg("dim", COMPACT_RESUME_HINT), width));
	} else {
		if (sessionName) {
			content.push(centerLine(theme.bold(sessionName), width));
			content.push("");
			content.push("");
		}
		const t = Math.min(1, elapsedMs / 6000);
		const left = renderEmberField({ cols: BAR_WIDTH, rows: BAR_ROWS, time: t, trueColor: TERMINAL.trueColor });
		const right = renderEmberField({
			cols: BAR_WIDTH,
			rows: BAR_ROWS,
			time: t,
			trueColor: TERMINAL.trueColor,
			seed: 7,
		});
		for (let i = 0; i < BAR_ROWS; i++) {
			content.push(centerLine(`${left[i]}${" ".repeat(BAR_GAP)}${right[i]}`, width));
		}
		content.push("");
		content.push(centerLine(theme.bold(theme.fg("accent", TITLE)), width));
		content.push("");
		for (let bi = 0; bi < BODY_LINES.length; bi++) {
			content.push(centerLine(theme.fg("muted", BODY_LINES[bi]!), width));
		}
		content.push("");
		content.push(centerLine(theme.fg("dim", `paused for ${formatClock(elapsedMs)}`), width));
		content.push("");
		content.push(centerLine(theme.fg("dim", RESUME_HINT), width));
	}

	const topPad = Math.max(0, Math.floor((height - content.length) / 2));
	const lines: string[] = new Array(topPad).fill("");
	for (let i = 0; i < content.length; i++) lines.push(content[i]!);
	while (lines.length < height) lines.push("");
	return lines.slice(0, Math.max(1, height));
}
