import { padding, type SelectItem, truncateToWidth, visibleWidth } from "@veyyon/tui";
import { clampLow } from "@veyyon/utils";
import { withIcon } from "../../theme/icon-label";
import { theme } from "../../theme/theme";

export type ThemeMode = "curated" | "all";

export const THEME_ITEMS: readonly SelectItem[] = [
	{ value: "auto", label: "Match terminal", description: "Follows your terminal's light/dark" },
	{ value: "theme:titanium", label: "Titanium", description: "Default dark theme" },
	{ value: "theme:light", label: "Light", description: "Default light theme" },
	{ value: "browse", label: "Browse all…", description: "Every built-in and custom theme" },
];

export const COLORBLIND_TOGGLE = "toggle:colorblind";
export const ASCII_TOGGLE = "toggle:ascii";

function fitLine(line: string, width: number): string {
	return truncateToWidth(line, width, undefined, true);
}

function fillStyledLine(content: string, width: number): string {
	return content + padding(Math.max(0, width - visibleWidth(content)));
}

function renderMockStatusLine(width: number): string {
	const sep = theme.fg("statusLineSep", ` ${theme.sep.pipe} `);
	const left = [
		theme.fg("statusLineModel", withIcon(theme.icon.model, "sonnet")),
		theme.fg("statusLinePath", "~/project"),
		theme.fg("statusLineGitDirty", withIcon(theme.icon.git, "main +2")),
	].join(sep);
	const right = [
		theme.fg("statusLineContext", withIcon(theme.icon.context, "42%")),
		theme.fg("statusLineCost", withIcon(theme.icon.cost, "0.18")),
	].join(sep);
	const innerWidth = Math.max(1, width - 2);
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	const gap = padding(Math.max(1, innerWidth - leftWidth - rightWidth - 2));
	return theme.bg("statusLineBg", fitLine(` ${left}${gap}${right} `, width));
}

function renderMockEditor(width: number): string[] {
	const box = theme.boxSharp;
	const innerWidth = Math.max(1, width - 2);
	const horizontal = box.horizontal.repeat(innerWidth);
	const top = theme.fg("borderAccent", `${box.topLeft}${horizontal}${box.topRight}`);
	const bottom = theme.fg("borderMuted", `${box.bottomLeft}${horizontal}${box.bottomRight}`);
	const prompt = `${theme.fg("accent", ">")} ${theme.fg("text", "Ask anything, edit files, run tools")}${theme.inverse(" ")}`;
	const hint = theme.fg("dim", "enter send · shift+enter newline · / commands");
	return [
		top,
		`${theme.fg("borderAccent", box.vertical)}${fitLine(prompt, innerWidth)}${theme.fg("borderAccent", box.vertical)}`,
		`${theme.fg("borderMuted", box.vertical)}${fillStyledLine(hint, innerWidth)}${theme.fg("borderMuted", box.vertical)}`,
		bottom,
	];
}

export const MIN_LIST_ROWS = 4;
export const PREVIEW_TRAILING_BLANK = 1;

export function renderThemePreview(width: number, rows = Number.POSITIVE_INFINITY): string[] {
	const previewWidth = clampLow(width, 24, 88);
	const swatch = [
		theme.bold("Preview"),
		`${theme.fg("success", `${theme.status.success} success`)}  ${theme.fg("warning", `${theme.status.warning} warning`)}  ${theme.fg("error", `${theme.status.error} error`)}  ${theme.fg("accent", "accent")}`,
	];
	const statusLine = ["", theme.fg("muted", "Status line"), renderMockStatusLine(previewWidth)];
	const editor = [theme.fg("muted", "Editor")].concat(renderMockEditor(previewWidth));
	if (rows >= swatch.length + statusLine.length + editor.length) return swatch.concat(statusLine, editor);
	if (rows >= swatch.length + statusLine.length) return swatch.concat(statusLine);
	return swatch;
}
