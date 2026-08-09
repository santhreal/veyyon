/**
 * Render file listings with optional icons and metadata.
 */
// Owners, not `../modes/theme/theme`: the engine is 282 modules and forwards both of these. This file is
// reached from the local `./index` barrel, which `tools/bash.ts` and `tools/write.ts` import, so the engine
// arrived in both of them through one name.
import type { Theme } from "../modes/theme/theme-class";
import { getLanguageFromPath } from "../utils/lang-from-path";
import { renderTreeList } from "./tree-list";

export interface FileEntry {
	path: string;
	/** Absolute filesystem path. When provided together with {@link FileListOptions.hyperlinkFn}, the
	 * rendered path text is wrapped in an OSC 8 hyperlink. */
	absPath?: string;
	isDirectory?: boolean;
	meta?: string;
}

export interface FileListOptions {
	files: FileEntry[];
	expanded?: boolean;
	maxCollapsed?: number;
	showIcons?: boolean;
	/** When provided, called with the entry's absolute path and the ANSI-styled display string to
	 * optionally wrap the path in an OSC 8 hyperlink. Only invoked when {@link FileEntry.absPath} is set. */
	hyperlinkFn?: (absPath: string, displayText: string) => string;
}

export function renderFileList(options: FileListOptions, theme: Theme): string[] {
	const { files, expanded = false, maxCollapsed = 8, showIcons = true, hyperlinkFn } = options;

	return renderTreeList(
		{
			items: files,
			expanded,
			maxCollapsed,
			itemType: "file",
			renderItem: entry => {
				const isDirectory = entry.isDirectory ?? entry.path.endsWith("/");
				const displayPath = isDirectory && entry.path.endsWith("/") ? entry.path : entry.path;
				const lang = isDirectory ? undefined : getLanguageFromPath(displayPath);
				// A file's badge comes with its own separator, because `fg("muted", "")` is a pair of
				// escapes rather than an empty string: the old `icon ? ... : ""` test read a preset
				// with no glyph for this language as a badge and indented the row by one column.
				const iconPrefix = showIcons
					? isDirectory
						? `${theme.fg("accent", theme.icon.folder)} `
						: theme.langBadge(lang)
					: "";
				const labelColor = isDirectory ? "accent" : "toolOutput";
				const meta = entry.meta ? ` ${theme.fg("dim", entry.meta)}` : "";
				const pathStr = theme.fg(labelColor, displayPath);
				const linkedPath = entry.absPath && hyperlinkFn ? hyperlinkFn(entry.absPath, pathStr) : pathStr;
				return `${iconPrefix}${linkedPath}${meta}`;
			},
		},
		theme,
	);
}
