/**
 * How the desktop reaches every setting the terminal settings screen offers.
 *
 * The `Settings` snapshot section lists every path of `SETTINGS_SCHEMA` with
 * its value, schema and visibility (`dumpSettings`), and `SetSetting` writes any
 * path the schema declares. A schema path is therefore carried as itself unless
 * it is recorded here as a gap or as terminal-only. The terminal screen also
 * draws synthetic rows with no schema path of their own; each is mapped to the
 * setting it edits.
 */
import { SETTINGS_SCHEMA } from "../../config/settings-schema";
import type { DesktopCarrier } from "./carrier";

/**
 * Settings whose only reader is the terminal renderer, by exact path or by
 * prefix (a key ending in `.`). The desktop draws with GPUI and ignores them;
 * the `Settings` section still lists them, so the profile the terminal reads can
 * be edited from the desktop.
 */
export const TERMINAL_ONLY_SETTINGS: Readonly<Record<string, string>> = {
	"tui.": "Terminal renderer tuning (text sizing, scrollback, hyperlinks, inline image cells); the desktop renders with GPUI.",
	"statusLine.": "The terminal status line; the desktop draws session facts from the ActiveSession section instead.",
	showHardwareCursor: "The terminal hardware cursor; the desktop editor draws its own caret.",
	symbolPreset: "The terminal glyph set (Unicode, Nerd Font, ASCII); the desktop draws its own icons.",
	"startup.clearScrollback": "Clears the terminal scrollback at launch; a desktop window has no scrollback.",
};

/**
 * Rows the terminal settings screen draws without a schema path of their own,
 * keyed by the row id `getAllSettingDefs` gives them.
 */
export const SYNTHETIC_SETTING_ROW_CARRIERS: Readonly<Record<string, DesktopCarrier>> = {
	// The `default` slot of `modelRoles`, which the Settings section lists and
	// `SetSetting` writes.
	defaultModel: { setting: "modelRoles" },
	// The `advisor` slot of `modelRoles`.
	advisorModel: { setting: "modelRoles" },
};

/** Schema paths the `Settings` section omits, with the user-facing impact. */
export const RECORDED_SETTING_GAPS: Readonly<Record<string, string>> = {};

function terminalOnlyReason(path: string): string | undefined {
	for (const [rule, reason] of Object.entries(TERMINAL_ONLY_SETTINGS)) {
		if (rule.endsWith(".") ? path.startsWith(rule) : path === rule) return reason;
	}
	return undefined;
}

/**
 * The carrier for one settings row id: a schema path or a synthetic row.
 * Returns `undefined` for an id with no recorded decision.
 */
export function desktopSettingCarrier(id: string): DesktopCarrier | undefined {
	const synthetic = SYNTHETIC_SETTING_ROW_CARRIERS[id];
	if (synthetic) return synthetic;
	const gap = RECORDED_SETTING_GAPS[id];
	if (gap !== undefined) return { gap };
	if (!Object.hasOwn(SETTINGS_SCHEMA, id)) return undefined;
	const reason = terminalOnlyReason(id);
	if (reason !== undefined) return { optOut: reason };
	return { setting: id };
}
