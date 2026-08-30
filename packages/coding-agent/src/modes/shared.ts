import type { TabBarTheme } from "@veyyon/tui";
import { hoverBand, theme } from "./theme/theme";

// ═══════════════════════════════════════════════════════════════════════════
// Text Sanitization
// ═══════════════════════════════════════════════════════════════════════════

export { sanitizeStatusText } from "./sanitize-status-text";

// ═══════════════════════════════════════════════════════════════════════════
// Tab Bar Theme
// ═══════════════════════════════════════════════════════════════════════════

/** Shared tab bar theme used by fullscreen overlays (settings, the subagent dashboard). */
export function getTabBarTheme(): TabBarTheme {
	return {
		label: (text: string) => theme.bold(theme.fg("accent", text)),
		// The ACTIVE tab is the strip's one piece of state, so its label takes the state accent on
		// the band rather than plain `text`. Both surfaces that use this theme showed a white label
		// on a tinted band, which reads as a highlight somebody drew rather than as the live tab:
		// the dashboard's `Live (1)` and, through `renderVertical`, the settings category sidebar.
		activeTab: (text: string) => theme.bold(theme.bg("selectedBg", theme.stateAccent(text))),
		inactiveTab: (text: string) => theme.fg("muted", text),
		mutedTab: (text: string) => theme.fg("dim", text),
		// The same band the lists paint, at whatever strength the fade has reached.
		// At full strength these are the bytes the switched band always had.
		hoverTab: (text: string, strength: number) => hoverBand(theme.fg("text", text), strength),
		hint: (text: string) => theme.fg("dim", text),
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Working-message hint
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Suffix appended to the loader's working message to remind users they can
 * abort with Esc. Rendered with the active theme's bracket glyphs so it stays
 * visually consistent with badges and other bracketed UI affordances.
 *
 * The leading space separates the hint from the message body and is consumed
 * by `endsWith`/`slice` matching in the loader renderer.
 */
export function interruptHint(): string {
	return ` ${theme.format.bracketLeft}esc${theme.format.bracketRight}`;
}

export { parseCommandArgs } from "../utils/command-args";
