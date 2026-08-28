import type { Theme } from "../modes/theme/theme-class";
import { formatMoreItems } from "../tools/render-utils";
import { getLanguageFromPath } from "../utils/lang-from-path";

export interface FileEntry {
	path: string;
	absPath?: string;
	isDirectory?: boolean;
	meta?: string;
}

export interface FileListOptions {
	files: FileEntry[];
	expanded?: boolean;
	maxCollapsed?: number;
	showIcons?: boolean;
	hyperlinkFn?: (absPath: string, displayText: string) => string;
}

export function renderFileList(options: FileListOptions, theme: Theme): string[] {
	const { files, expanded = false, maxCollapsed = 8, showIcons = true, hyperlinkFn } = options;

	const maxItems = expanded ? files.length : Math.min(files.length, maxCollapsed);
	const lines: string[] = [];

	for (let i = 0; i < maxItems; i++) {
		const entry = files[i]!;
		const isDirectory = entry.isDirectory ?? entry.path.endsWith("/");
		const displayPath = entry.path;
		const lang = isDirectory ? undefined : getLanguageFromPath(displayPath);
		const iconPrefix = showIcons
			? isDirectory
				? `${theme.fg("accent", theme.icon.folder)} `
				: theme.langBadge(lang)
			: "";
		const labelColor = isDirectory ? "accent" : "toolOutput";
		const meta = entry.meta ? ` ${theme.fg("dim", entry.meta)}` : "";
		const pathStr = theme.fg(labelColor, displayPath);
		const linkedPath = entry.absPath && hyperlinkFn ? hyperlinkFn(entry.absPath, pathStr) : pathStr;
		const indent = isDirectory ? "" : "  ";
		lines.push(`${indent}${iconPrefix}${linkedPath}${meta}`);
	}

	const remaining = files.length - maxItems;
	if (!expanded && remaining > 0) {
		lines.push(theme.fg("dim", formatMoreItems(remaining, "file")));
	}

	return lines;
}
