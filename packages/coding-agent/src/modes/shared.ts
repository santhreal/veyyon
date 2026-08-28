import type { TabBarTheme } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils";
import { hoverBand, theme } from "./theme/theme";

/**
 * Sanitize text for display in a single-line status indicator. Strips all
 * 7-bit and 8-bit ANSI escape sequences via `@veyyon/utils`, maps remaining
 * C0 and C1 control characters to spaces, collapses consecutive spaces into a
 * single space, and trims leading and trailing whitespace.
 *
 * The escape grammar is owned directly rather than delegated to the runtime
 * environment to ensure consistent stripping across platforms and runtime
 * versions.
 */
export function sanitizeStatusText(text: string): string {
	return stripAnsi(text)
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/** Shared tab bar theme used by fullscreen overlays (settings, the Agent Control Center). */
export function getTabBarTheme(): TabBarTheme {
	return {
		label: (text: string) => theme.bold(theme.fg("accent", text)),
		activeTab: (text: string) => theme.bold(theme.bg("selectedBg", theme.fg("text", text))),
		inactiveTab: (text: string) => theme.fg("muted", text),
		mutedTab: (text: string) => theme.fg("dim", text),
		// The same band the lists paint, at whatever strength the fade has reached.
		// At full strength these are the bytes the switched band always had.
		hoverTab: (text: string, strength: number) => hoverBand(theme.fg("text", text), strength),
		hint: (text: string) => theme.fg("dim", text),
	};
}

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
